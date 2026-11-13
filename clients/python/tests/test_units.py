"""Pure unit tests: SSE parser, queue comments, stream folding, error
mapping, retry decisions and the backoff schedule. No network."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from typing import Any
from unittest import mock

from molochai_http import (
    CAP_NOTICE,
    MolochAI,
    MolochAIError,
    QueueProgress,
    SSEParser,
    _parse_retry_after,
    backoff_delay,
    collect_stream,
    error_from_response,
    me_url,
    parse_queue_comment,
    retry_decision,
)


def feed_all(parser: SSEParser, text: str) -> list[str]:
    events = []
    for line in text.splitlines(keepends=True):
        event = parser.feed(line)
        if event is not None:
            events.append(event)
    return events


class SSEParserTest(unittest.TestCase):
    def test_data_events_end_at_blank_lines(self) -> None:
        events = feed_all(SSEParser(), 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n')
        self.assertEqual(events, ['{"a":1}', '{"b":2}', "[DONE]"])

    def test_comments_are_never_payload_but_reach_the_callback(self) -> None:
        seen: list[str] = []
        parser = SSEParser(on_comment=seen.append)
        events = feed_all(parser, ": ka\n\n: queued · position 2 of 3 · waiting 4s\n\ndata: x\n\n: hb\n\n")
        self.assertEqual(events, ["x"])
        self.assertEqual(seen, ["ka", "queued · position 2 of 3 · waiting 4s", "hb"])

    def test_comment_inside_an_event_is_skipped(self) -> None:
        self.assertEqual(feed_all(SSEParser(), "data: a\n: ka\ndata: b\n\n"), ["a\nb"])

    def test_multiline_data_crlf_and_no_space(self) -> None:
        events = feed_all(SSEParser(), "data:one\r\ndata:  two\r\n\r\n")
        self.assertEqual(events, ["one\n two"])

    def test_other_fields_are_ignored(self) -> None:
        self.assertEqual(feed_all(SSEParser(), "event: message\nid: 7\nretry: 100\ndata: x\n\n"), ["x"])

    def test_blank_lines_without_data_dispatch_nothing(self) -> None:
        self.assertEqual(feed_all(SSEParser(), "\n\n\n"), [])

    def test_flush_returns_an_unterminated_event(self) -> None:
        parser = SSEParser()
        self.assertIsNone(parser.feed("data: tail\n"))
        self.assertEqual(parser.flush(), "tail")
        self.assertIsNone(parser.flush())


class QueueCommentTest(unittest.TestCase):
    def test_parses_the_gateway_format(self) -> None:
        self.assertEqual(
            parse_queue_comment("queued · position 2 of 3 · waiting 4s"),
            QueueProgress(position=2, total=3, waited_s=4),
        )

    def test_anything_else_is_none(self) -> None:
        for text in ["ka", "hb", "queued", "queued · position x of 3 · waiting 4s", ""]:
            self.assertIsNone(parse_queue_comment(text), text)


class CollectStreamTest(unittest.TestCase):
    def chunk(self, delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
        return {"object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}

    def test_joins_content_reasoning_and_reads_usage(self) -> None:
        usage = {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
        result = collect_stream(
            [
                self.chunk({"role": "assistant", "content": ""}),
                self.chunk({"reasoning_content": "think "}),
                self.chunk({"reasoning_content": "hard"}),
                self.chunk({"content": "Hello "}),
                self.chunk({"content": None}),
                self.chunk({"content": "world"}),
                self.chunk({}, "stop"),
                {"object": "chat.completion.chunk", "choices": [], "usage": usage},
            ]
        )
        self.assertEqual(result.content, "Hello world")
        self.assertEqual(result.reasoning, "think hard")
        self.assertEqual(result.finish_reason, "stop")
        self.assertEqual(result.usage, usage)
        self.assertFalse(result.hit_output_cap)

    def test_joins_tool_call_fragments_by_index(self) -> None:
        result = collect_stream(
            [
                self.chunk({"tool_calls": [{"index": 0, "id": "c0", "type": "function", "function": {"name": "a"}}]}),
                self.chunk({"tool_calls": [{"index": 1, "id": "c1", "function": {"name": "b", "arguments": "{}"}}]}),
                self.chunk({"tool_calls": [{"index": 0, "function": {"arguments": '{"x":'}}]}),
                self.chunk({"tool_calls": [{"index": 0, "function": {"arguments": " 1}"}}]}),
                self.chunk({}, "tool_calls"),
            ]
        )
        self.assertEqual(
            result.tool_calls,
            [
                {"id": "c0", "type": "function", "function": {"name": "a", "arguments": '{"x": 1}'}},
                {"id": "c1", "type": "function", "function": {"name": "b", "arguments": "{}"}},
            ],
        )
        self.assertEqual(result.finish_reason, "tool_calls")

    def test_cap_notice(self) -> None:
        result = collect_stream([self.chunk({"content": "partial" + CAP_NOTICE}), self.chunk({}, "length")])
        self.assertTrue(result.hit_output_cap)

    def test_on_chunk_sees_every_chunk(self) -> None:
        seen: list[dict[str, Any]] = []
        collect_stream([self.chunk({"content": "a"}), {"choices": [], "usage": {}}], on_chunk=seen.append)
        self.assertEqual(len(seen), 2)


class ErrorMappingTest(unittest.TestCase):
    def test_shape_a_quota_with_resets_at(self) -> None:
        raw = (
            b'{"error":{"type":"quota_exceeded","message":"cap","resets_at":"2026-12-01T00:00:00+00:00","plan":"pro"}}'
        )
        err = error_from_response(429, {"Content-Type": "application/json"}, raw)
        self.assertEqual((err.status, err.type, err.message), (429, "quota_exceeded", "cap"))
        self.assertEqual(err.resets_at, datetime(2026, 12, 1, tzinfo=timezone.utc))
        self.assertEqual(err.body["error"]["plan"], "pro")
        self.assertIsNone(err.retry_after)

    def test_resets_at_with_z(self) -> None:
        raw = b'{"error":{"type":"session_quota_exceeded","message":"m","resets_at":"2026-11-13T07:00:00Z"}}'
        err = error_from_response(429, {}, raw)
        self.assertEqual(err.resets_at, datetime(2026, 11, 13, 7, tzinfo=timezone.utc))

    def test_shape_b_validation(self) -> None:
        raw = b'{"message":"The selected model is invalid.","errors":{"model":["The selected model is invalid."]}}'
        err = error_from_response(422, {}, raw)
        self.assertEqual(err.type, "validation_error")
        self.assertEqual(err.body["errors"]["model"], ["The selected model is invalid."])

    def test_shape_c(self) -> None:
        self.assertEqual(error_from_response(401, {}, b'{"message":"Unauthenticated."}').type, "unauthenticated")
        rate = error_from_response(429, {"Retry-After": "7"}, b'{"message":"Too Many Attempts."}')
        self.assertEqual((rate.type, rate.retry_after), ("rate_limited", 7.0))
        unverified = error_from_response(403, {}, b'{"message":"Verify.","code":"email_unverified"}')
        self.assertEqual(unverified.type, "email_unverified")
        self.assertEqual(error_from_response(404, {}, b'{"message":"Not found."}').type, "http_error")

    def test_non_json_bodies(self) -> None:
        err = error_from_response(524, {"content-type": "text/html"}, b"<html>timeout</html>")
        self.assertEqual(err.type, "cloudflare_timeout")
        self.assertEqual(err.body, "<html>timeout</html>")
        self.assertEqual(error_from_response(500, {}, b"").type, "http_error")
        self.assertEqual(error_from_response(500, {}, b"[1, 2]").type, "http_error")

    def test_request_id(self) -> None:
        raw = b'{"error":{"type":"upstream_error","message":"m","status":500,"request_id":"r-1"}}'
        self.assertEqual(error_from_response(502, {}, raw).request_id, "r-1")
        self.assertIsNone(error_from_response(401, {}, b'{"message":"x"}').request_id)

    def test_retry_after_http_date(self) -> None:
        self.assertEqual(_parse_retry_after("Thu, 01 Jan 1970 00:00:30 GMT", now=0), 30.0)
        self.assertIsNone(_parse_retry_after("soon"))
        self.assertIsNone(_parse_retry_after(None))

    def test_str(self) -> None:
        self.assertEqual(str(MolochAIError("boom", status=503, type="server_busy")), "HTTP 503 server_busy: boom")
        self.assertEqual(str(MolochAIError("x", type="connection_error")), "no response connection_error: x")


class RetryDecisionTest(unittest.TestCase):
    def decide(self, status: int | None, type_: str, **kw: bool) -> str | None:
        return retry_decision(MolochAIError("m", status=status, type=type_), **kw)

    def test_backoff_cases(self) -> None:
        for status, type_ in [
            (502, "upstream_unreachable"),
            (502, "upstream_timeout"),
            (502, "no_usage_accounting"),
            (502, "upstream_error"),
            (503, "server_busy"),
            (504, "upstream_timeout"),
            (524, "cloudflare_timeout"),
            (500, "upstream_error"),
            (None, "connection_error"),
        ]:
            self.assertEqual(self.decide(status, type_), "backoff", (status, type_))

    def test_rate_limit_waits_retry_after(self) -> None:
        self.assertEqual(self.decide(429, "rate_limited"), "retry_after")

    def test_never_retried(self) -> None:
        for status, type_ in [
            (401, "unauthenticated"),
            (402, "no_active_plan"),
            (403, "email_unverified"),
            (413, "context_length_exceeded"),
            (422, "validation_error"),
            (429, "quota_exceeded"),
            (429, "session_quota_exceeded"),
            (503, "model_unavailable"),
            (404, "http_error"),
        ]:
            self.assertIsNone(self.decide(status, type_), (status, type_))

    def test_timeouts_only_on_request(self) -> None:
        self.assertIsNone(self.decide(None, "timeout"))
        self.assertEqual(self.decide(None, "timeout", retry_on_timeout=True), "backoff")

    def test_in_stream_errors_are_not_retried(self) -> None:
        err = MolochAIError("m", status=200, type="server_busy", in_stream=True)
        self.assertIsNone(retry_decision(err))


class BackoffTest(unittest.TestCase):
    def test_upper_bound_doubles_until_the_cap(self) -> None:
        delays = [backoff_delay(n, base=0.5, cap=8.0, rand=lambda: 1.0) for n in range(7)]
        self.assertEqual(delays, [0.5, 1.0, 2.0, 4.0, 8.0, 8.0, 8.0])

    def test_full_jitter_scales_the_bound(self) -> None:
        self.assertEqual(backoff_delay(3, base=0.5, cap=8.0, rand=lambda: 0.0), 0.0)
        self.assertEqual(backoff_delay(3, base=0.5, cap=8.0, rand=lambda: 0.25), 1.0)

    def test_default_random_stays_in_range(self) -> None:
        for n in range(6):
            delay = backoff_delay(n)
            self.assertGreaterEqual(delay, 0.0)
            self.assertLess(delay, min(8.0, 0.5 * 2**n))


class ConfigTest(unittest.TestCase):
    def test_me_url(self) -> None:
        self.assertEqual(me_url("https://api.molochai.dev/api/v1"), "https://api.molochai.dev/api/auth/me")
        self.assertEqual(me_url("http://127.0.0.1:4010/api/v1/"), "http://127.0.0.1:4010/api/auth/me")
        with self.assertRaises(ValueError):
            me_url("https://api.molochai.dev/openai")

    def test_env_and_defaults(self) -> None:
        with mock.patch.dict("os.environ", {"MOLOCHAI_API_KEY": "k"}, clear=True):
            client = MolochAI()
            self.assertEqual(client.base_url, "https://api.molochai.dev/api/v1")
        with mock.patch.dict(
            "os.environ", {"MOLOCHAI_API_KEY": "k", "MOLOCHAI_BASE_URL": "http://127.0.0.1:1/api/v1/"}, clear=True
        ):
            self.assertEqual(MolochAI().base_url, "http://127.0.0.1:1/api/v1")

    def test_missing_key(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True), self.assertRaises(ValueError):
            MolochAI()

    def test_repr_hides_the_key(self) -> None:
        self.assertNotIn("secret-key", repr(MolochAI(api_key="secret-key")))


if __name__ == "__main__":
    unittest.main()
