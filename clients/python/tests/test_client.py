"""The reference client against the mock server, run as a subprocess.

Retries use an injected sleep that records the delays instead of waiting, so
the retry tests are fast. Timeout tests use real (short) timeouts.
"""

from __future__ import annotations

import itertools
import socket
import time
import unittest
from datetime import datetime, timezone
from typing import Any

from molochai_http import MolochAI, MolochAIError, QueueProgress, collect_stream
from tests.mock_server import MockServer

MODEL = "glm-5.3-flash"
_counter = itertools.count()

mock: MockServer
slow_stream_mock: MockServer


def setUpModule() -> None:
    global mock, slow_stream_mock
    mock = MockServer("--unavailable", "qwen3.8-27b-uncensored", "--rate-limit", "0")
    slow_stream_mock = MockServer("--delay-ms", "400", "--rate-limit", "0")


def tearDownModule() -> None:
    mock.stop()
    slow_stream_mock.stop()


def unique(text: str) -> str:
    """Bodies differ per test, so [mock:flaky=N] counters never collide."""
    return f"{text} #{next(_counter)}-{time.time_ns()}"


def user(text: str) -> list[dict[str, Any]]:
    return [{"role": "user", "content": text}]


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.sleeps: list[float] = []
        self.retries: list[tuple[str, int, float]] = []

    def client(self, base_url: str | None = None, **kwargs: Any) -> MolochAI:
        options: dict[str, Any] = {
            "sleep": self.sleeps.append,
            "rand": lambda: 1.0,  # upper bound of the jitter, so delays are predictable
            "on_retry": lambda err, attempt, delay: self.retries.append((err.type, attempt, delay)),
        }
        options.update(kwargs)
        return MolochAI(api_key="mock-key", base_url=base_url or mock.base_url, **options)

    def expect_error(self, fn: Any, *args: Any, **kwargs: Any) -> MolochAIError:
        with self.assertRaises(MolochAIError) as ctx:
            fn(*args, **kwargs)
        return ctx.exception


class ChatTest(Base):
    def test_chat(self) -> None:
        reply = self.client().chat(MODEL, user("Hello"), temperature=0.2, top_p=0.9, max_tokens=50)
        self.assertEqual(reply["object"], "chat.completion")
        self.assertEqual(reply["model"], MODEL)
        choice = reply["choices"][0]
        self.assertEqual(choice["finish_reason"], "stop")
        self.assertEqual(choice["message"]["content"], f"Mock reply from {MODEL}: Hello")
        self.assertEqual(choice["message"]["reasoning_content"], f"Mock reasoning for {MODEL}.")
        usage = reply["usage"]
        self.assertEqual(usage["total_tokens"], usage["prompt_tokens"] + usage["completion_tokens"])
        self.assertEqual(self.sleeps, [])

    def test_tool_call_round_trip(self) -> None:
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                },
            }
        ]
        client = self.client()
        first = client.chat(MODEL, user("Weather in Oslo?"), tools=tools)
        message = first["choices"][0]["message"]
        self.assertEqual(first["choices"][0]["finish_reason"], "tool_calls")
        call = message["tool_calls"][0]
        self.assertEqual(call["function"]["name"], "get_weather")
        self.assertEqual(call["function"]["arguments"], '{"city":"example"}')

        follow_up = [*user("Weather in Oslo?"), message, {"role": "tool", "tool_call_id": call["id"], "content": "4 C"}]
        second = client.chat(MODEL, follow_up, tools=tools)
        self.assertEqual(
            second["choices"][0]["message"]["content"], f"Mock reply from {MODEL} after tool get_weather: 4 C"
        )

    def test_models(self) -> None:
        models = self.client().models()
        self.assertEqual(len(models), 5)
        by_id = {m["id"]: m for m in models}
        self.assertFalse(by_id["qwen3.8-27b-uncensored"]["available"])
        self.assertTrue(by_id[MODEL]["available"])

    def test_me_is_derived_from_the_base_url(self) -> None:
        me = self.client().me()
        self.assertEqual(me["api_base"], mock.base_url)
        self.assertEqual(me["email"], "dev@example.com")
        self.assertIsNone({m["id"]: m for m in me["models"]}["qwen3.8-27b-uncensored"]["context_limit"])


class StreamTest(Base):
    def test_stream_chunks_and_usage(self) -> None:
        chunks = list(self.client().chat_stream(MODEL, user("Stream this please")))
        self.assertEqual(chunks[0]["choices"][0]["delta"]["role"], "assistant")
        self.assertEqual(chunks[-1]["choices"], [])
        self.assertIn("usage", chunks[-1])
        result = collect_stream(chunks)
        self.assertEqual(result.content, f"Mock reply from {MODEL}: Stream this please")
        self.assertEqual(result.reasoning, f"Mock reasoning for {MODEL}.")
        self.assertEqual(result.finish_reason, "stop")
        self.assertEqual(result.usage, chunks[-1]["usage"])

    def test_queue_progress_and_comments(self) -> None:
        queue: list[QueueProgress] = []
        comments: list[str] = []
        stream = self.client().chat_stream(
            MODEL, user("wait [mock:queue]"), on_queue=queue.append, on_comment=comments.append
        )
        result = collect_stream(stream)
        self.assertEqual(queue, [QueueProgress(2, 3, 1), QueueProgress(1, 3, 2)])
        self.assertIn("ka", comments)
        self.assertNotIn("queued", result.content)

    def test_stream_tool_call(self) -> None:
        tools = [{"type": "function", "function": {"name": "search", "parameters": {"properties": {"q": {}}}}}]
        result = collect_stream(self.client().chat_stream(MODEL, user("find"), tools=tools))
        self.assertEqual(result.finish_reason, "tool_calls")
        self.assertEqual(result.tool_calls[0]["function"], {"name": "search", "arguments": '{"q":null}'})

    def test_cap_notice(self) -> None:
        result = collect_stream(self.client().chat_stream(MODEL, user("long [mock:cap]")))
        self.assertTrue(result.hit_output_cap)
        self.assertEqual(result.finish_reason, "length")

    def test_in_stream_errors_are_raised_after_the_content_so_far(self) -> None:
        for marker, type_ in [("[mock:timeout]", "upstream_timeout"), ("[mock:preempted]", "preempted")]:
            received: list[dict[str, Any]] = []
            with self.assertRaises(MolochAIError) as ctx:
                for chunk in self.client().chat_stream(MODEL, user(f"a b c {marker}")):
                    received.append(chunk)
            err = ctx.exception
            self.assertEqual((err.status, err.type, err.in_stream), (200, type_, True))
            self.assertEqual(collect_stream(received).content, "Mock reply ")
            self.assertEqual(self.sleeps, [], "in-stream errors are not retried")

    def test_errors_before_the_stream_opens_are_retried(self) -> None:
        result = collect_stream(self.client().chat_stream(MODEL, user(unique("[mock:flaky=1]"))))
        self.assertEqual(result.finish_reason, "stop")
        self.assertEqual(self.sleeps, [0.5])

    def test_mid_stream_read_timeout(self) -> None:
        client = self.client(base_url=slow_stream_mock.base_url, read_timeout=0.15)
        err = self.expect_error(lambda: list(client.chat_stream(MODEL, user("slow chunks"))))
        self.assertEqual((err.type, err.in_stream), ("timeout", True))


class ErrorMappingTest(Base):
    def test_401(self) -> None:
        client = self.client()
        client._api_key = ""  # sends "Bearer " with nothing after it
        err = self.expect_error(client.models)
        self.assertEqual((err.status, err.type, err.body), (401, "unauthenticated", {"message": "Unauthenticated."}))
        self.assertEqual(self.sleeps, [])

    def test_402_and_403(self) -> None:
        no_plan = MolochAI(api_key="mock-no-plan", base_url=mock.base_url, sleep=self.sleeps.append)
        err = self.expect_error(no_plan.chat, MODEL, user("hi"))
        self.assertEqual((err.status, err.type), (402, "no_active_plan"))
        unverified = MolochAI(api_key="mock-unverified", base_url=mock.base_url, sleep=self.sleeps.append)
        err = self.expect_error(unverified.models)
        self.assertEqual((err.status, err.type), (403, "email_unverified"))
        self.assertFalse(unverified.me()["email_verified"], "/auth/me still answers")
        self.assertEqual(self.sleeps, [])

    def test_413(self) -> None:
        err = self.expect_error(self.client().chat, MODEL, user("[mock:context]"))
        self.assertEqual((err.status, err.type), (413, "context_length_exceeded"))
        self.assertEqual(err.body["error"]["context_cap"], 65536)
        self.assertEqual(err.body["error"]["bound_by"], "plan")
        self.assertEqual(self.sleeps, [])

    def test_422(self) -> None:
        err = self.expect_error(self.client().chat, "no-such-model", user("hi"))
        self.assertEqual((err.status, err.type), (422, "validation_error"))
        self.assertEqual(err.body["errors"]["model"], ["The selected model is invalid."])
        self.assertEqual(self.sleeps, [])

    def test_quota_429s_are_not_retried_and_expose_resets_at(self) -> None:
        for marker, type_ in [("[mock:quota]", "quota_exceeded"), ("[mock:session-quota]", "session_quota_exceeded")]:
            err = self.expect_error(self.client().chat, MODEL, user(marker))
            self.assertEqual((err.status, err.type), (429, type_))
            assert err.resets_at is not None
            self.assertGreater(err.resets_at, datetime.now(timezone.utc))
        self.assertEqual(self.sleeps, [])

    def test_model_unavailable_is_not_retried(self) -> None:
        err = self.expect_error(self.client().chat, "qwen3.8-27b-uncensored", user("hi"))
        self.assertEqual((err.status, err.type), (503, "model_unavailable"))
        self.assertEqual(err.body["error"]["model"], "qwen3.8-27b-uncensored")
        self.assertEqual(self.sleeps, [])


class RetryTest(Base):
    def test_rate_limit_waits_retry_after(self) -> None:
        err = self.expect_error(self.client(max_retries=2).chat, MODEL, user("[mock:rate-limit]"))
        self.assertEqual((err.status, err.type, err.retry_after), (429, "rate_limited", 1.0))
        self.assertEqual(self.sleeps, [1.0, 1.0])

    def test_retry_after_is_capped(self) -> None:
        self.expect_error(self.client(max_retries=1, max_retry_after=0.25).chat, MODEL, user("[mock:rate-limit]"))
        self.assertEqual(self.sleeps, [0.25])

    def test_backoff_statuses_retry_then_raise(self) -> None:
        cases = [
            ("[mock:busy]", 503, "server_busy"),
            ("[mock:upstream-error]", 502, "upstream_error"),
            ("[mock:timeout]", 504, "upstream_timeout"),
            ("[mock:preempted]", 502, "upstream_unreachable"),
            ("[mock:cloudflare-524]", 524, "cloudflare_timeout"),
        ]
        for marker, status, type_ in cases:
            self.sleeps.clear()
            self.retries.clear()
            err = self.expect_error(self.client().chat, MODEL, user(marker))
            self.assertEqual((err.status, err.type), (status, type_), marker)
            self.assertEqual(self.sleeps, [0.5, 1.0, 2.0], marker)
            self.assertEqual([attempt for _, attempt, _ in self.retries], [1, 2, 3])

    def test_524_body_is_kept_as_text(self) -> None:
        err = self.expect_error(self.client(max_retries=0).chat, MODEL, user("[mock:cloudflare-524]"))
        self.assertIsInstance(err.body, str)
        self.assertIn("<html", err.body)

    def test_flaky_recovers_within_the_retry_budget(self) -> None:
        reply = self.client().chat(MODEL, user(unique("[mock:flaky=2]")))
        self.assertEqual(reply["choices"][0]["finish_reason"], "stop")
        self.assertEqual(self.sleeps, [0.5, 1.0])
        self.assertEqual([t for t, _, _ in self.retries], ["upstream_unreachable", "upstream_unreachable"])

    def test_flaky_beyond_the_budget_fails(self) -> None:
        err = self.expect_error(self.client(max_retries=2).chat, MODEL, user(unique("[mock:flaky=5]")))
        self.assertEqual(err.type, "upstream_unreachable")
        self.assertEqual(len(self.sleeps), 2)

    def test_max_retries_zero(self) -> None:
        self.expect_error(self.client(max_retries=0).chat, MODEL, user("[mock:busy]"))
        self.assertEqual(self.sleeps, [])

    def test_connection_errors_are_retried(self) -> None:
        with socket.socket() as s:  # find a port with nothing listening
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        # Linux refuses at once; Windows retries the SYN for ~2 s, so the short
        # connect timeout keeps the test fast there (a connect timeout is also
        # a connection error).
        client = self.client(base_url=f"http://127.0.0.1:{port}/api/v1", connect_timeout=0.5, max_retries=2)
        err = self.expect_error(client.models)
        self.assertEqual((err.status, err.type), (None, "connection_error"))
        self.assertEqual(self.sleeps, [0.5, 1.0])


class TimeoutTest(Base):
    def test_read_timeout_is_not_retried_by_default(self) -> None:
        started = time.monotonic()
        err = self.expect_error(self.client(read_timeout=0.2).chat, MODEL, user("[mock:slow=1500]"))
        self.assertEqual((err.status, err.type), (None, "timeout"))
        self.assertLess(time.monotonic() - started, 1.4)
        self.assertEqual(self.sleeps, [])

    def test_read_timeout_retried_when_asked(self) -> None:
        client = self.client(read_timeout=0.2, retry_on_timeout=True, max_retries=1)
        err = self.expect_error(client.chat, MODEL, user("[mock:slow=1500]"))
        self.assertEqual(err.type, "timeout")
        self.assertEqual(self.sleeps, [0.5])

    def test_slow_reply_within_the_timeout(self) -> None:
        reply = self.client(read_timeout=5).chat(MODEL, user("[mock:slow=300]"))
        self.assertEqual(reply["choices"][0]["finish_reason"], "stop")


if __name__ == "__main__":
    unittest.main()
