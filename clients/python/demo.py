"""Walk through the API with the reference client: account, models, a plain
chat request and a streamed one.

    MOLOCHAI_API_KEY=your-api-key python clients/python/demo.py [--model ID] [prompt]

Offline, against the mock server:

    node mock-server/server.mjs --port 4010 &
    MOLOCHAI_BASE_URL=http://127.0.0.1:4010/api/v1 MOLOCHAI_API_KEY=mock-key python clients/python/demo.py
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

from molochai_http import MolochAI, MolochAIError, QueueProgress, collect_stream

KEYS_URL = "https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("prompt", nargs="?", default="Explain server-sent events in two sentences.")
    parser.add_argument("--model", help="model id (default: the account's default model)")
    args = parser.parse_args()

    if not os.environ.get("MOLOCHAI_API_KEY"):
        print(f"Set MOLOCHAI_API_KEY first. Create a key at {KEYS_URL}", file=sys.stderr)
        return 2

    client = MolochAI(
        on_retry=lambda err, attempt, delay: print(f"  retry {attempt} in {delay:.1f}s after {err}", file=sys.stderr),
    )

    try:
        me = client.me()
        print(f"Account: plan={me['plan']} tier={me['tier']} email_verified={me['email_verified']}")

        models = client.models()
        print("Models:")
        for m in models:
            print(f"  {m['id']:<38} {'available' if m['available'] else 'not served right now'}")

        model = args.model or me.get("default_model") or next(m["id"] for m in models if m["available"])
        messages = [{"role": "user", "content": args.prompt}]

        print(f"\nPlain request to {model}:")
        reply = client.chat(model, messages)
        message = reply["choices"][0]["message"]
        print(f"  {message['content']}")
        print(f"  finish_reason={reply['choices'][0]['finish_reason']} usage={reply['usage']}")

        print(f"\nStreamed request to {model}:")

        def on_queue(progress: QueueProgress) -> None:
            print(f"  (queued: position {progress.position} of {progress.total})", file=sys.stderr)

        def show(chunk: dict[str, Any]) -> None:
            for choice in chunk.get("choices") or []:  # the usage chunk has none
                print(choice.get("delta", {}).get("content") or "", end="", flush=True)

        print("  ", end="")
        result = collect_stream(client.chat_stream(model, messages, on_queue=on_queue), on_chunk=show)
        print(f"\n  finish_reason={result.finish_reason} usage={result.usage}")
        if result.reasoning:
            print(f"  reasoning: {len(result.reasoning)} characters (not shown)")
        if result.hit_output_cap:
            print("  The reply hit the plan's output cap.")
    except MolochAIError as err:
        print(f"Request failed: {err}", file=sys.stderr)
        if err.resets_at:
            print(f"  The quota resets at {err.resets_at.isoformat()}", file=sys.stderr)
        if err.request_id:
            print(f"  request_id={err.request_id}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
