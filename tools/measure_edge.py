"""Measure the edge (Cloudflare) timeout and streaming behavior of the MolochAI API.

Two requests with the same long task, both on a model with reasoning on:

  plain   stream=false. Records how long until a response arrives and its status. A 524
          (HTML from Cloudflare) after N seconds means the edge gave up at N seconds while the
          origin was still generating; a 200 means the reply finished before the edge limit.
  stream  stream=true. Records time to first byte, to first comment, to first data event, to
          first content, the longest silence between any two received lines, the cadence of
          comment lines (": ka", ": hb", ": queued ..."), total duration, whether the usage
          chunk and [DONE] arrived, and any in-stream error event.

Standard library only. The key is read from MOLOCHAI_API_KEY and never printed.

    MOLOCHAI_API_KEY=... python measure_edge.py [--model glm-5.3-flash] [--only plain|stream]
                                                [--max-seconds 420] [--json out.json]

Cost: two requests capped by the plan's per-reply output limit (9,000 tokens on most plans),
so at most about 18,000 output tokens in total.
"""

from __future__ import annotations

import argparse
import http.client
import itertools
import json
import os
import ssl
import sys
import time
from urllib.parse import urlsplit

BASE = os.environ.get("MOLOCHAI_BASE_URL", "https://api.molochai.dev/api/v1").rstrip("/")
PROMPT = (
    "Write a long, detailed technical reference: for each of 120 common Linux command-line "
    "tools, give a heading, three sentences on what it does, and two example invocations with "
    "an explanation of each flag. Do not summarize or skip tools; write all 120 in full."
)


def connect(timeout: float) -> tuple[http.client.HTTPConnection, str]:
    u = urlsplit(BASE)
    if u.scheme == "http":  # the mock server, for testing this script
        return http.client.HTTPConnection(u.hostname, u.port or 80, timeout=timeout), u.path
    conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=timeout, context=ssl.create_default_context())
    return conn, u.path


def headers(key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "User-Agent": "molochai-edge-measure/1",
        "Accept": "text/event-stream, application/json",
    }


def pick(h: http.client.HTTPResponse) -> dict[str, str | None]:
    keys = [
        "cf-ray",
        "server",
        "content-type",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-should-retry",
        "cf-cache-status",
    ]
    return {k: h.getheader(k) for k in keys}


def plain(key: str, model: str, max_s: float, prompt: str = PROMPT) -> dict:
    conn, path = connect(max_s)
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}]})
    t0 = time.monotonic()
    out: dict = {"mode": "plain", "model": model}
    try:
        conn.request("POST", f"{path}/chat/completions", body=body, headers=headers(key))
        r = conn.getresponse()
        out["seconds_to_headers"] = round(time.monotonic() - t0, 1)
        raw = r.read()
        out["seconds_total"] = round(time.monotonic() - t0, 1)
        out["status"] = r.status
        out["headers"] = pick(r)
        if r.status == 200:
            data = json.loads(raw)
            out["finish_reason"] = data["choices"][0].get("finish_reason")
            out["usage"] = data.get("usage")
        else:
            text = raw[:400].decode("utf-8", "replace")
            out["body_start"] = text if "<" not in text[:1] else "(HTML) " + " ".join(text.split())[:200]
    except Exception as err:
        out["seconds_total"] = round(time.monotonic() - t0, 1)
        out["client_error"] = f"{type(err).__name__}: {err}"
    finally:
        conn.close()
    return out


def stream(key: str, model: str, max_s: float, prompt: str = PROMPT) -> dict:
    conn, path = connect(max_s)
    body = json.dumps({"model": model, "stream": True, "messages": [{"role": "user", "content": prompt}]})
    t0 = time.monotonic()
    out: dict = {"mode": "stream", "model": model, "comments": {}, "errors": []}
    marks: dict[str, float] = {}
    last = t0
    longest_gap = 0.0
    comment_times: list[float] = []
    content_chars = reasoning_chars = 0
    try:
        conn.request("POST", f"{path}/chat/completions", body=body, headers=headers(key))
        r = conn.getresponse()
        out["status"] = r.status
        out["headers"] = pick(r)
        marks["headers"] = time.monotonic()
        if r.status != 200:
            out["body_start"] = r.read(400).decode("utf-8", "replace")
            return out
        while True:
            line = r.readline()
            if not line:
                break
            now = time.monotonic()
            longest_gap = max(longest_gap, now - last)
            last = now
            marks.setdefault("first_byte", now)
            s = line.decode("utf-8", "replace").rstrip("\r\n")
            if not s:
                continue
            if s.startswith(":"):
                marks.setdefault("first_comment", now)
                kind = s[1:].strip().split(" ")[0] or "(empty)"
                out["comments"][kind] = out["comments"].get(kind, 0) + 1
                comment_times.append(now)
                continue
            if not s.startswith("data:"):
                continue
            payload = s[5:].strip()
            if payload == "[DONE]":
                marks["done"] = now
                break
            marks.setdefault("first_data", now)
            ev = json.loads(payload)
            if "error" in ev:
                out["errors"].append(
                    {"at_s": round(now - t0, 1), **{k: ev["error"].get(k) for k in ("type", "elapsed_s")}}
                )
                continue
            if not ev.get("choices"):
                if ev.get("usage"):
                    out["usage"] = ev["usage"]
                    marks["usage"] = now
                continue
            d = ev["choices"][0].get("delta", {})
            if d.get("reasoning_content"):
                marks.setdefault("first_reasoning", now)
                reasoning_chars += len(d["reasoning_content"])
            if d.get("content"):
                marks.setdefault("first_content", now)
                content_chars += len(d["content"])
            if ev["choices"][0].get("finish_reason"):
                out["finish_reason"] = ev["choices"][0]["finish_reason"]
    except Exception as err:
        out["client_error"] = f"{type(err).__name__}: {err}"
    finally:
        conn.close()
    end = time.monotonic()
    out["seconds"] = {k: round(v - t0, 1) for k, v in sorted(marks.items(), key=lambda kv: kv[1])}
    out["seconds_total"] = round(end - t0, 1)
    out["longest_silence_s"] = round(longest_gap, 1)
    gaps = [b - a for a, b in itertools.pairwise(comment_times)]
    out["comment_interval_s"] = (
        {"median": round(sorted(gaps)[len(gaps) // 2], 2), "max": round(max(gaps), 2)} if gaps else None
    )
    out["chars"] = {"reasoning": reasoning_chars, "content": content_chars}
    out["usage_chunk"] = "usage" in marks
    out["done"] = "done" in marks
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--model", default=os.environ.get("MEASURE_MODEL") or "glm-5.3-flash")
    ap.add_argument("--only", choices=["plain", "stream"])
    ap.add_argument("--max-seconds", type=float, default=420.0)
    ap.add_argument("--json")
    ap.add_argument("--prompt", default=PROMPT, help="override the long task (for testing)")
    a = ap.parse_args()
    key = os.environ.get("MOLOCHAI_API_KEY", "").strip()
    if not key:
        print("MOLOCHAI_API_KEY is not set", file=sys.stderr)
        return 2
    results = []
    if a.only in (None, "stream"):
        results.append(stream(key, a.model, a.max_seconds, a.prompt))
        print(json.dumps(results[-1], indent=2), flush=True)
    if a.only in (None, "plain"):
        results.append(plain(key, a.model, a.max_seconds, a.prompt))
        print(json.dumps(results[-1], indent=2), flush=True)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump({"base": BASE, "results": results}, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
