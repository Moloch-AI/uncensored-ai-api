"""MolochAI reference HTTP client: one file, Python standard library only.

Copy this file into your project when you want to call the MolochAI API without
installing an SDK. It shows everything a client has to get right on the wire:

* bearer auth and the base URL (``MOLOCHAI_API_KEY``, ``MOLOCHAI_BASE_URL``);
* separate connect and read timeouts;
* the three error-body shapes, mapped to one exception with ``status``,
  ``type``, ``body``, ``retry_after`` and ``resets_at``;
* retries: exponential backoff with full jitter for 502, 503 ``server_busy``,
  504, 524, other 5xx and connection errors; ``Retry-After`` (capped) for the
  rate-limit 429; no retry for quota 429s, ``model_unavailable``, 401, 402,
  403, 413 or 422;
* a server-sent events parser that ignores comment lines but reports queue
  progress (``: queued · position 2 of 3 · waiting 4s``) through a callback;
* in-stream error events (HTTP 200, then ``data: {"error": ...}``) raised as
  errors, and the usage chunk whose ``choices`` is empty;
* ``/auth/me``, which lives outside ``/v1``.

Requires Python 3.10 or newer. It is a reference, not a package: there is no
async variant and responses are plain dicts in the wire format. For a typed
SDK, see https://github.com/Moloch-AI/uncensored-ai-python.

Example::

    from molochai_http import MolochAI

    client = MolochAI()  # reads MOLOCHAI_API_KEY and MOLOCHAI_BASE_URL
    reply = client.chat("glm-5.3-flash", [{"role": "user", "content": "Hi"}])
    print(reply["choices"][0]["message"]["content"])

License: MIT. Source: https://github.com/Moloch-AI/uncensored-ai-api
"""

from __future__ import annotations

import functools
import http.client
import json
import os
import random
import re
import ssl
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

__all__ = [
    "CAP_NOTICE",
    "DEFAULT_BASE_URL",
    "MolochAI",
    "MolochAIError",
    "QueueProgress",
    "SSEParser",
    "StreamResult",
    "backoff_delay",
    "collect_stream",
    "error_from_response",
    "me_url",
    "parse_queue_comment",
    "retry_decision",
]

DEFAULT_BASE_URL = "https://api.molochai.dev/api/v1"

#: Appended to the content when a reply stops at the plan's output cap.
CAP_NOTICE = "\n\n[Response is too large for your current plan. Try a smaller request.]"

USER_AGENT = "molochai-http-reference-python/0.1"

JSONDict = dict[str, Any]
Message = Mapping[str, Any]


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


class MolochAIError(Exception):
    """Any failed request: an HTTP error, a connection problem, or an error
    event inside a stream.

    Attributes:
        status: HTTP status. ``None`` when no response arrived (connection
            error, timeout). 200 for an error event inside a stream.
        type: What went wrong, for branching. The gateway's ``error.type`` when
            the body has one (``quota_exceeded``, ``server_busy``, ...);
            ``code`` for the 403 (``email_unverified``); otherwise a label this
            client assigns: ``unauthenticated`` (401), ``validation_error``
            (422), ``rate_limited`` (429 "Too Many Attempts."),
            ``cloudflare_timeout`` (524), ``http_error`` (anything else),
            ``connection_error``, ``timeout``, ``incomplete_stream``,
            ``invalid_response``.
        message: Human-readable text. It can change; do not branch on it.
        body: Parsed JSON body, the raw text when it was not JSON, or None.
        headers: Response headers (lower-case names), empty without a response.
        retry_after: Seconds from the ``Retry-After`` header, if present.
        resets_at: When a quota error clears (from ``error.resets_at``).
        in_stream: True when the error arrived as an event in an open stream.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        type: str = "http_error",  # noqa: A002 - mirrors the wire field name
        body: Any = None,
        headers: Mapping[str, str] | None = None,
        retry_after: float | None = None,
        resets_at: datetime | None = None,
        in_stream: bool = False,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.type = type
        self.body = body
        self.headers = dict(headers or {})
        self.retry_after = retry_after
        self.resets_at = resets_at
        self.in_stream = in_stream

    @property
    def request_id(self) -> str | None:
        """The gateway's ``request_id`` on upstream errors, for support requests."""
        if isinstance(self.body, dict) and isinstance(self.body.get("error"), dict):
            value = self.body["error"].get("request_id")
            return value if isinstance(value, str) else None
        return None

    def __str__(self) -> str:
        where = f"HTTP {self.status}" if self.status is not None else "no response"
        return f"{where} {self.type}: {self.message}"


def _parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    """``Retry-After`` is seconds (what the gateway sends) or an HTTP date."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    current = time.time() if now is None else now
    return max(0.0, when.timestamp() - current)


def _parse_datetime(value: Any) -> datetime | None:
    """ISO 8601 such as ``2026-12-01T00:00:00+00:00``. Python 3.10's
    ``fromisoformat`` does not accept a trailing ``Z``, so map it first."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def error_from_response(status: int, headers: Mapping[str, str], raw: bytes) -> MolochAIError:
    """Map an HTTP error response to a :class:`MolochAIError`.

    Always check the status first, then the body shape. Bodies come in three
    shapes, and some are not JSON at all (Cloudflare's 524 page is HTML)::

        A  {"error": {"type": "...", "message": "...", ...}}   gateway errors
        B  {"message": "...", "errors": {"field": ["..."]}}     422 validation
        C  {"message": "..."} (+ "code" on the 403)             401, 403, 429 rate limit
    """
    lower = {k.lower(): v for k, v in headers.items()}
    text = raw.decode("utf-8", errors="replace")
    retry_after = _parse_retry_after(lower.get("retry-after"))
    try:
        body: Any = json.loads(text)
    except ValueError:
        body = None

    def make(type_: str, message: str, resets_at: datetime | None = None) -> MolochAIError:
        return MolochAIError(
            message,
            status=status,
            type=type_,
            body=body if body is not None else text,
            headers=lower,
            retry_after=retry_after,
            resets_at=resets_at,
        )

    if isinstance(body, dict) and isinstance(body.get("error"), dict):  # shape A
        error = body["error"]
        return make(
            str(error.get("type") or "http_error"),
            str(error.get("message") or f"HTTP {status}"),
            _parse_datetime(error.get("resets_at")),
        )
    if isinstance(body, dict) and isinstance(body.get("errors"), dict):  # shape B
        return make("validation_error", str(body.get("message") or "Invalid request."))
    if isinstance(body, dict) and "message" in body:  # shape C
        if isinstance(body.get("code"), str):
            type_ = body["code"]
        else:
            type_ = {401: "unauthenticated", 429: "rate_limited"}.get(status, "http_error")
        return make(type_, str(body["message"]))

    # Not JSON (or JSON we do not recognize). Never assume JSON.
    type_ = "cloudflare_timeout" if status == 524 else "http_error"
    return make(type_, f"HTTP {status} with a non-JSON body")


# --------------------------------------------------------------------------
# Retry policy
# --------------------------------------------------------------------------


def retry_decision(error: MolochAIError, *, retry_on_timeout: bool = False) -> str | None:
    """How to retry ``error``: ``"backoff"``, ``"retry_after"`` or ``None``.

    ===============================================  ==============
    error                                            decision
    ===============================================  ==============
    connection error (no response)                   backoff
    read timeout                                     None, unless retry_on_timeout
    429 ``rate_limited`` ("Too Many Attempts.")      retry_after
    429 ``quota_exceeded`` / ``session_...``         None: surface resets_at
    401, 402, 403, 413, 422                          None: fix the cause
    503 ``model_unavailable``                        None: pick another model
    502, 503 ``server_busy``, 504, 524, other 5xx    backoff
    error event inside an open stream                None: content was already sent
    anything else                                    None
    ===============================================  ==============

    A read timeout is not retried by default: the server may still be
    generating (and counting tokens for) the first attempt.
    """
    if error.in_stream:
        return None
    if error.status is None:
        if error.type == "timeout":
            return "backoff" if retry_on_timeout else None
        return "backoff" if error.type == "connection_error" else None
    if error.status == 429:
        return "retry_after" if error.type == "rate_limited" else None
    if error.status == 503 and error.type == "model_unavailable":
        return None
    if error.status >= 500:
        return "backoff"
    return None


def backoff_delay(
    attempt: int,
    *,
    base: float = 0.5,
    cap: float = 8.0,
    rand: Callable[[], float] = random.random,
) -> float:
    """Exponential backoff with full jitter: uniform in [0, min(cap, base * 2**attempt)).

    ``attempt`` counts from 0 for the first retry. Full jitter spreads clients
    out so they do not all come back at the same moment.
    """
    return rand() * min(cap, base * 2.0**attempt)


# --------------------------------------------------------------------------
# Server-sent events
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class QueueProgress:
    """Parsed from ``: queued · position 2 of 3 · waiting 4s``."""

    position: int
    total: int
    waited_s: int


_QUEUE_RE = re.compile(r"queued\s*·\s*position\s+(\d+)\s+of\s+(\d+)\s*·\s*waiting\s+(\d+)s")


def parse_queue_comment(text: str) -> QueueProgress | None:
    """Optional progress info. The format is not a contract: if it does not
    parse, treat the comment like any other and ignore it."""
    match = _QUEUE_RE.search(text)
    if not match:
        return None
    return QueueProgress(int(match[1]), int(match[2]), int(match[3]))


class SSEParser:
    """Incremental parser for ``text/event-stream``, fed one line at a time.

    The rules that matter here (from the SSE specification):

    * an event is a block of lines ended by a blank line;
    * ``data:`` lines carry the payload (several are joined with ``\\n``);
      one space after the colon is dropped;
    * lines starting with ``:`` are comments: never part of the payload;
    * other fields (``event:``, ``id:``, ``retry:``) are not used by this API.

    ``feed`` returns the payload of a finished event, or None.
    """

    def __init__(self, on_comment: Callable[[str], None] | None = None) -> None:
        self._data: list[str] = []
        self._on_comment = on_comment

    def feed(self, line: str) -> str | None:
        line = line.rstrip("\r\n")
        if line == "":
            if not self._data:
                return None
            payload = "\n".join(self._data)
            self._data = []
            return payload
        if line.startswith(":"):
            if self._on_comment:
                self._on_comment(line[1:].strip())
            return None
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "data":
            self._data.append(value)
        return None

    def flush(self) -> str | None:
        """Payload of a final event that was not followed by a blank line."""
        return self.feed("") if self._data else None


@dataclass
class StreamResult:
    """A streamed reply put back together."""

    content: str = ""
    reasoning: str = ""
    tool_calls: list[JSONDict] = field(default_factory=list)
    finish_reason: str | None = None
    usage: JSONDict | None = None

    @property
    def hit_output_cap(self) -> bool:
        """True when the reply stopped at the plan's output cap."""
        return self.finish_reason == "length" or self.content.endswith(CAP_NOTICE)


def collect_stream(chunks: Iterable[JSONDict], on_chunk: Callable[[JSONDict], None] | None = None) -> StreamResult:
    """Fold ``chat.completion.chunk`` objects into a :class:`StreamResult`.

    Tool-call arguments arrive whole on this gateway, but other providers send
    fragments, so they are joined by ``index`` here.
    """
    result = StreamResult()
    calls: dict[int, JSONDict] = {}
    for chunk in chunks:
        if on_chunk:
            on_chunk(chunk)
        if chunk.get("usage"):
            result.usage = chunk["usage"]
        for choice in chunk.get("choices") or []:  # empty in the usage chunk
            delta = choice.get("delta") or {}
            result.content += delta.get("content") or ""
            result.reasoning += delta.get("reasoning_content") or ""
            for fragment in delta.get("tool_calls") or []:
                call = calls.setdefault(
                    int(fragment.get("index", 0)),
                    {"id": None, "type": "function", "function": {"name": "", "arguments": ""}},
                )
                if fragment.get("id"):
                    call["id"] = fragment["id"]
                fn = fragment.get("function") or {}
                call["function"]["name"] += fn.get("name") or ""
                call["function"]["arguments"] += fn.get("arguments") or ""
            if choice.get("finish_reason"):
                result.finish_reason = choice["finish_reason"]
    result.tool_calls = [calls[i] for i in sorted(calls)]
    return result


# --------------------------------------------------------------------------
# Transport: urllib with separate connect and read timeouts
# --------------------------------------------------------------------------
#
# urllib.request takes one timeout and applies it to connecting and to every
# read. A plain chat request only sends its headers once the whole reply is
# generated, so the read timeout must be long while the connect timeout should
# be short. These small subclasses connect with the connect timeout and then
# switch the socket to the read timeout. Everything else (proxies from the
# environment, TLS verification) is standard urllib.


class _HTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args: Any, read_timeout: float, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._read_timeout = read_timeout

    def connect(self) -> None:
        super().connect()  # bounded by the connect timeout
        assert self.sock is not None
        self.sock.settimeout(self._read_timeout)  # every read after this


class _HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args: Any, read_timeout: float, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._read_timeout = read_timeout

    def connect(self) -> None:
        super().connect()
        assert self.sock is not None
        self.sock.settimeout(self._read_timeout)


class _HTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, read_timeout: float) -> None:
        super().__init__()
        self._read_timeout = read_timeout

    def http_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        conn = functools.partial(_HTTPConnection, read_timeout=self._read_timeout)
        return self.do_open(conn, req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, read_timeout: float, context: ssl.SSLContext) -> None:
        super().__init__(context=context)
        self._read_timeout = read_timeout
        self._ssl_context = context

    def https_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        conn = functools.partial(_HTTPSConnection, read_timeout=self._read_timeout)
        return self.do_open(conn, req, context=self._ssl_context)


def me_url(base_url: str) -> str:
    """``/auth/me`` lives outside ``/v1``: replace the trailing ``/v1``.

    >>> me_url("https://api.molochai.dev/api/v1")
    'https://api.molochai.dev/api/auth/me'
    """
    base = base_url.rstrip("/")
    if not base.endswith("/v1"):
        raise ValueError(f"cannot derive /auth/me: base URL does not end in /v1: {base_url}")
    return base[: -len("/v1")] + "/auth/me"


# --------------------------------------------------------------------------
# Client
# --------------------------------------------------------------------------


class MolochAI:
    """Small synchronous client for the three public endpoints.

    Args:
        api_key: Defaults to ``MOLOCHAI_API_KEY``. Keep keys on a server; they
            are not scoped and must never ship to a browser or mobile app.
        base_url: Defaults to ``MOLOCHAI_BASE_URL``, then the production URL.
        connect_timeout: Seconds to establish the connection.
        read_timeout: Seconds to wait on any single read. For a plain request
            this covers the whole generation; for a stream, the gap between
            events (keep-alive comments arrive about once a second).
        max_retries: Retries after the first attempt (0 disables retrying).
        backoff_base, backoff_max: Backoff schedule, see :func:`backoff_delay`.
        max_retry_after: Longest ``Retry-After`` wait honored on a 429; a longer
            value is cut to this.
        retry_on_timeout: Also retry read timeouts (off: the first attempt may
            still be running on the server).
        sleep, rand: Injected for tests.
        on_retry: Called as ``on_retry(error, attempt, delay)`` before each wait.
        ssl_context: Custom TLS settings; defaults to verified system CAs.

    If you also use another HTTP layer that retries (the OpenAI SDKs do),
    disable one of them so the retries do not multiply.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        *,
        connect_timeout: float = 10.0,
        read_timeout: float = 120.0,
        max_retries: int = 3,
        backoff_base: float = 0.5,
        backoff_max: float = 8.0,
        max_retry_after: float = 60.0,
        retry_on_timeout: bool = False,
        sleep: Callable[[float], None] = time.sleep,
        rand: Callable[[], float] = random.random,
        on_retry: Callable[[MolochAIError, int, float], None] | None = None,
        ssl_context: ssl.SSLContext | None = None,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get("MOLOCHAI_API_KEY", "")
        if not key:
            raise ValueError("No API key: pass api_key or set MOLOCHAI_API_KEY.")
        self._api_key = key
        self.base_url = (base_url or os.environ.get("MOLOCHAI_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.backoff_max = backoff_max
        self.max_retry_after = max_retry_after
        self.retry_on_timeout = retry_on_timeout
        self._sleep = sleep
        self._rand = rand
        self._on_retry = on_retry
        self._opener = urllib.request.build_opener(
            _HTTPHandler(read_timeout),
            _HTTPSHandler(read_timeout, ssl_context or ssl.create_default_context()),
        )

    def __repr__(self) -> str:  # never print the key
        return f"MolochAI(base_url={self.base_url!r})"

    # ---------------------------------------------------------------- API

    def chat(self, model: str, messages: Sequence[Message], **params: Any) -> JSONDict:
        """``POST /chat/completions`` without streaming; returns the
        ``chat.completion`` dict.

        ``params`` may hold ``temperature`` (0-2), ``top_p`` (0-1), ``tools``,
        ``tool_choice`` and ``max_tokens`` (accepted, but it has no effect: the
        plan's output cap applies). Other OpenAI parameters such as ``stop``,
        ``seed`` or ``response_format`` are silently dropped by the gateway;
        there is no JSON mode.

        Prefer :meth:`chat_stream` for long replies: Cloudflare gives up on a
        plain response after about 100 seconds (524).
        """
        payload = {"model": model, "messages": list(messages), **params, "stream": False}
        with self._request("POST", f"{self.base_url}/chat/completions", payload) as resp:
            return self._read_json(resp)

    def chat_stream(
        self,
        model: str,
        messages: Sequence[Message],
        *,
        on_queue: Callable[[QueueProgress], None] | None = None,
        on_comment: Callable[[str], None] | None = None,
        **params: Any,
    ) -> Iterator[JSONDict]:
        """``POST /chat/completions`` with ``stream: true``; yields each
        ``chat.completion.chunk`` dict, including the final usage chunk (whose
        ``choices`` is empty). Use :func:`collect_stream` to put them together.

        Retries happen only before the stream opens. An error event inside the
        stream raises :class:`MolochAIError` with ``in_stream=True``.

        Args:
            on_queue: Called with :class:`QueueProgress` while the request waits
                for a slot.
            on_comment: Called with every comment line (``ka``, ``hb``, ...).
        """
        payload = {"model": model, "messages": list(messages), **params, "stream": True}

        def comment(text: str) -> None:
            if on_comment:
                on_comment(text)
            progress = parse_queue_comment(text)
            if progress and on_queue:
                on_queue(progress)

        resp = self._request("POST", f"{self.base_url}/chat/completions", payload, stream=True)
        parser = SSEParser(on_comment=comment)
        try:
            for raw in resp:  # one line at a time
                data = parser.feed(raw.decode("utf-8"))
                if data is None:
                    continue
                if data == "[DONE]":
                    return
                try:
                    event = json.loads(data)
                except ValueError as exc:
                    raise MolochAIError(
                        "A stream event was not JSON.",
                        status=resp.status,
                        type="invalid_response",
                        body=data,
                        in_stream=True,
                    ) from exc
                if isinstance(event, dict) and isinstance(event.get("error"), dict):
                    error = event["error"]
                    raise MolochAIError(
                        str(error.get("message") or "Error in stream."),
                        status=resp.status,
                        type=str(error.get("type") or "stream_error"),
                        body=event,
                        headers={k.lower(): v for k, v in resp.headers.items()},
                        in_stream=True,
                    )
                yield event
            raise MolochAIError(
                "The stream ended without [DONE]; the connection was cut.",
                status=resp.status,
                type="incomplete_stream",
                in_stream=True,
            )
        except TimeoutError as exc:
            raise MolochAIError(
                f"No data for {self.read_timeout} s while streaming.", type="timeout", in_stream=True
            ) from exc
        except (ConnectionError, http.client.HTTPException) as exc:  # cut mid-stream
            raise MolochAIError(
                f"Connection lost while streaming: {exc!r}", type="connection_error", in_stream=True
            ) from exc
        finally:
            resp.close()

    def models(self) -> list[JSONDict]:
        """``GET /models``. ``available: false`` means nothing serves that id now."""
        with self._request("GET", f"{self.base_url}/models") as resp:
            body = self._read_json(resp)
        data = body.get("data")
        return data if isinstance(data, list) else []

    def me(self) -> JSONDict:
        """``GET /api/auth/me``: plan, tier, credit, ``email_verified`` and the
        per-model ``context_limit``."""
        with self._request("GET", me_url(self.base_url)) as resp:
            return self._read_json(resp)

    # ----------------------------------------------------------- internals

    def _request(self, method: str, url: str, payload: Any = None, *, stream: bool = False) -> http.client.HTTPResponse:
        """Send with retries; return an open 2xx response or raise."""
        attempt = 0
        while True:
            try:
                return self._send_once(method, url, payload, stream)
            except MolochAIError as error:
                delay = self._retry_delay(error, attempt)
                if delay is None:
                    raise
                attempt += 1
                if self._on_retry:
                    self._on_retry(error, attempt, delay)
                self._sleep(delay)

    def _retry_delay(self, error: MolochAIError, attempt: int) -> float | None:
        if attempt >= self.max_retries:
            return None
        decision = retry_decision(error, retry_on_timeout=self.retry_on_timeout)
        if decision == "retry_after" and error.retry_after is not None:
            return min(error.retry_after, self.max_retry_after)
        if decision is not None:
            return backoff_delay(attempt, base=self.backoff_base, cap=self.backoff_max, rand=self._rand)
        return None

    def _send_once(self, method: str, url: str, payload: Any, stream: bool) -> http.client.HTTPResponse:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "text/event-stream" if stream else "application/json",
            "User-Agent": USER_AGENT,
        }
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            resp: http.client.HTTPResponse = self._opener.open(req, timeout=self.connect_timeout)
            return resp
        except urllib.error.HTTPError as exc:  # a response with status >= 400
            with exc:
                raw = exc.read()
            raise error_from_response(exc.code, dict(exc.headers.items()), raw) from None
        except urllib.error.URLError as exc:  # DNS, refused, TLS, connect timeout
            raise MolochAIError(f"Connection failed: {exc.reason}", type="connection_error") from exc
        except TimeoutError as exc:  # connected, then no response in time
            raise MolochAIError(f"No response within {self.read_timeout} s.", type="timeout") from exc
        except (ConnectionError, http.client.HTTPException) as exc:  # reset, closed early
            raise MolochAIError(f"Connection failed: {exc!r}", type="connection_error") from exc

    def _read_json(self, resp: http.client.HTTPResponse) -> JSONDict:
        try:
            raw = resp.read()
        except TimeoutError as exc:
            raise MolochAIError(f"No response within {self.read_timeout} s.", type="timeout") from exc
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise MolochAIError(
                "Expected a JSON object.",
                status=resp.status,
                type="invalid_response",
                body=raw.decode("utf-8", errors="replace"),
            )
        return body
