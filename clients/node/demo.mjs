// Walk through the API with the reference client: account, models, a plain
// chat request and a streamed one.
//
//   MOLOCHAI_API_KEY=your-api-key node clients/node/demo.mjs [--model ID] [prompt]
//
// Offline, against the mock server:
//
//   node mock-server/server.mjs --port 4010 &
//   MOLOCHAI_BASE_URL=http://127.0.0.1:4010/api/v1 MOLOCHAI_API_KEY=mock-key node clients/node/demo.mjs

import { parseArgs } from 'node:util';
import { collectStream, MolochAI, MolochAIError } from './molochai-http.mjs';

const KEYS_URL = 'https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api';

const { values, positionals } = parseArgs({
  options: { model: { type: 'string' } },
  allowPositionals: true,
});
const prompt = positionals[0] ?? 'Explain server-sent events in two sentences.';

if (!process.env.MOLOCHAI_API_KEY) {
  console.error(`Set MOLOCHAI_API_KEY first. Create a key at ${KEYS_URL}`);
  process.exit(2);
}

const client = new MolochAI({
  onRetry: (err, attempt, delayMs) =>
    console.error(`  retry ${attempt} in ${(delayMs / 1000).toFixed(1)}s after ${err}`),
});

try {
  const me = await client.me();
  console.log(`Account: plan=${me.plan} tier=${me.tier} email_verified=${me.email_verified}`);

  const models = await client.models();
  console.log('Models:');
  for (const m of models) {
    console.log(`  ${m.id.padEnd(38)} ${m.available ? 'available' : 'not served right now'}`);
  }

  const model = values.model ?? me.default_model ?? models.find((m) => m.available)?.id;
  const messages = [{ role: 'user', content: prompt }];

  console.log(`\nPlain request to ${model}:`);
  const reply = await client.chat(model, messages);
  console.log(`  ${reply.choices[0].message.content}`);
  console.log(`  finish_reason=${reply.choices[0].finish_reason} usage=${JSON.stringify(reply.usage)}`);

  console.log(`\nStreamed request to ${model}:`);
  process.stdout.write('  ');
  const stream = client.chatStream(model, messages, {
    onQueue: (q) => console.error(`  (queued: position ${q.position} of ${q.total})`),
  });
  const result = await collectStream(stream, {
    onChunk: (chunk) => {
      for (const choice of chunk.choices) process.stdout.write(choice.delta.content ?? ''); // usage chunk: no choices
    },
  });
  console.log(`\n  finish_reason=${result.finishReason} usage=${JSON.stringify(result.usage)}`);
  if (result.reasoning) console.log(`  reasoning: ${result.reasoning.length} characters (not shown)`);
  if (result.hitOutputCap) console.log("  The reply hit the plan's output cap.");
} catch (err) {
  if (!(err instanceof MolochAIError)) throw err;
  console.error(`Request failed: ${err}`);
  if (err.resetsAt) console.error(`  The quota resets at ${err.resetsAt.toISOString()}`);
  if (err.requestId) console.error(`  request_id=${err.requestId}`);
  process.exitCode = 1;
}
