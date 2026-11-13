# Streaming (server-sent events)

With `"stream": true`, `POST /chat/completions` answers `200` with
`Content-Type: text/event-stream` and sends the reply as it is generated. This
page is the wire format, the parsing rules, and what can go wrong once the
stream is open.

Prefer streaming for anything that might take a while: Cloudflare sits in front
of the API and gives up on a response after about 100 seconds, so a long plain
request can fail with `524` at the edge. A stream keeps the connection busy with
data and keep-alive comments.

## Grammar

The stream is a sequence of events. An event is one or more lines followed by a
blank line. Lines end in `\n` (accept `\r\n` too).

```text
stream      = *( event )
event       = 1*( line ) blank-line
line        = data-line / comment-line / other-field
data-line   = "data:" [ " " ] payload            ; one space after the colon is dropped
comment-line= ":" text                           ; ignore (see Comments)
other-field = name ":" value                     ; event:, id:, retry: are not used here
payload     = chunk-json / error-json / "[DONE]"
```

If an event has several `data:` lines, join their values with `\n`. This API
sends one `data:` line per event, but a parser that follows the rule costs
nothing.

## Order of a successful stream

1. A chunk with `delta.role` (`{"role":"assistant","content":""}`).
2. `delta.reasoning_content` chunks: thinking models, when the server keeps
   reasoning separate. Show them as reasoning or drop them; do not mix them into
   the answer.
3. `delta.content` chunks (or one `delta.tool_calls` chunk). Inline
   `<think>...</think>` blocks are stripped from `delta.content` by the gateway.
4. A chunk with `finish_reason`: `stop`, `length` or `tool_calls`.
5. The usage chunk: `"choices": []` and a `usage` object. Usage is always sent.
   Check for empty `choices` before indexing `choices[0]`.
6. `data: [DONE]`.

Comment lines can appear anywhere, including before the first data event.

## Comments

Lines starting with `:` are comments. They are never part of the reply and
parsers must ignore them. Seen in practice:

| Comment | Meaning |
|---|---|
| `: ka`, `: hb` | Keep-alives, about once a second during silence (for example while a thinking model reasons without streaming it). |
| `: queued · position 2 of 3 · waiting 4s` | The request is waiting for a slot. |

Treat any comment generically. The queue format is not a contract: parse it only
as optional progress information, and keep working if it does not match. Both
reference clients expose it through a callback (`on_queue` / `onQueue`) and
pass every comment to `on_comment` / `onComment`.

The OpenAI SDKs drop comment lines, so they cannot show queue progress. That is
fine for most uses: the stream works the same without it.

## Example

This is real output from the mock server in this repository (`[mock:queue]`
adds the queue comments; the mock's text is canned):

```text
: queued · position 2 of 3 · waiting 1s

: queued · position 1 of 3 · waiting 2s

data: {"id":"chatcmpl-mock-1","object":"chat.completion.chunk","created":1794536407,"model":"glm-5.3-flash","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-mock-1","object":"chat.completion.chunk","created":1794536407,"model":"glm-5.3-flash","choices":[{"index":0,"delta":{"reasoning_content":"Mock "},"finish_reason":null}]}

: ka

data: {"id":"chatcmpl-mock-1","object":"chat.completion.chunk","created":1794536407,"model":"glm-5.3-flash","choices":[{"index":0,"delta":{"content":"Mock "},"finish_reason":null}]}

data: {"id":"chatcmpl-mock-1","object":"chat.completion.chunk","created":1794536407,"model":"glm-5.3-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-mock-1","object":"chat.completion.chunk","created":1794536407,"model":"glm-5.3-flash","choices":[],"usage":{"prompt_tokens":6,"completion_tokens":22,"total_tokens":28}}

data: [DONE]
```

(Some reasoning and content chunks are left out above.) To see the full stream
yourself, run [`examples/curl/stream.sh`](../examples/curl/stream.sh) against the
mock.

## Tool calls

Tool-call arguments are not streamed piece by piece on this gateway: each call
arrives whole in one chunk, then a chunk with `finish_reason: "tool_calls"`.
Other OpenAI-compatible providers send fragments, so accumulate anyway:

- key calls by `delta.tool_calls[].index`;
- take `id`, `type` and `function.name` from the first fragment that has them;
- concatenate `function.arguments` pieces;
- parse the joined `arguments` as JSON only after the stream finishes, and
  validate it: the model can produce invalid JSON or arguments that do not
  match the schema.

`collect_stream` (Python) and `collectStream` (Node) in the reference clients do
exactly this.

## The cap notice

Each plan caps the output of one reply (see
[pricing](https://molochai.dev/pricing?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api)).
`max_tokens` is accepted but has no effect. When a reply stops at the cap with
no tool call, the gateway appends this exact text to the content, and
`finish_reason` is `length`:

```text
\n\n[Response is too large for your current plan. Try a smaller request.]
```

It arrives as ordinary `delta.content`. If you show replies to people, you can
detect it (`finish_reason == "length"`, or the content ends with the notice) and
render it as a notice rather than as model text.

## Errors after the stream opened

Once the `200` and the headers are sent, the status cannot change. Errors that
happen later arrive as one data event with an `error` object, followed by
`data: [DONE]`, and no finish or usage chunk:

```text
data: {"error":{"type":"upstream_timeout","message":"Server busy or request took too long.","elapsed_s":181.2}}

data: [DONE]
```

| `error.type` | Meaning |
|---|---|
| `server_busy` | No slot became free. |
| `upstream_unreachable` | The inference server could not be reached. |
| `upstream_timeout` | The inference server took too long. |
| `upstream_error` | The inference server returned an error; `status` has its HTTP status. |
| `preempted` | The server was reclaimed mid-reply. Retry in a minute. |

Rules for a client:

- Check every parsed data event for an `error` key before treating it as a chunk.
- Raise it as an error (both reference clients do, with `in_stream` / `inStream`
  set), after whatever content already arrived.
- Do not retry automatically: part of the reply was already delivered (and
  counted). Let the caller decide whether to send the request again.

A stream that ends without `[DONE]` was cut (network, proxy, server restart).
Treat it as an error too; the reference clients raise `incomplete_stream`.

## Timeouts

A healthy stream is never silent for long: keep-alive comments arrive about once
a second while nothing else is sent. So instead of a total deadline, use an idle
timeout: the longest gap you accept between any two lines. The reference
clients use their read timeout for this.

## Parser checklist

- [ ] Split on lines, buffer partial lines across network reads.
- [ ] Ignore lines starting with `:` (optionally report them).
- [ ] Join `data:` values of one event with `\n`; dispatch on the blank line.
- [ ] Stop at `[DONE]`.
- [ ] Check for `error` before using an event as a chunk.
- [ ] Check for empty `choices` (the usage chunk) before indexing.
- [ ] Accumulate tool-call fragments by `index`.
- [ ] Treat a stream without `[DONE]` as failed.

Implementations to copy: `SSEParser` in
[`clients/python/molochai_http.py`](../clients/python/molochai_http.py) and
[`clients/node/molochai-http.mjs`](../clients/node/molochai-http.mjs).
