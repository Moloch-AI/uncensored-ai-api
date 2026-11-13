#!/usr/bin/env node
// Command-line entry for the MolochAI mock API (package bin: molochai-mock).
//
//   node mock-server/server.mjs [--port 4010] [--host 127.0.0.1] [--delay-ms 15]
//                               [--unavailable <id>[,<id>]] [--rate-limit 60] [--quiet]
//
// Environment equivalents: MOCK_PORT, MOCK_HOST, MOCK_DELAY_MS,
// MOCK_UNAVAILABLE, MOCK_RATE_LIMIT. Flags win over the environment.
// Port 0 picks a free port; the line printed on stdout has the real one.

import { parseArgs } from 'node:util';
import { DEFAULTS, startMockServer } from './app.mjs';
import { MODEL_IDS } from './catalog.mjs';

const HELP = `MolochAI mock API (a test double: canned replies, not model output)

Usage: molochai-mock [options]

  --port <n>             port to listen on (env MOCK_PORT, default ${DEFAULTS.port}; 0 = any free port)
  --host <addr>          address to bind (env MOCK_HOST, default ${DEFAULTS.host})
  --delay-ms <n>         pause between stream chunks (env MOCK_DELAY_MS, default ${DEFAULTS.delayMs})
  --unavailable <ids>    comma-separated model ids to report as unavailable (env MOCK_UNAVAILABLE)
  --rate-limit <n>       requests per minute per token (env MOCK_RATE_LIMIT, default ${DEFAULTS.rateLimit}; 0 = off)
  --quiet                do not log requests to stderr
  -h, --help             show this help

Clients: MOLOCHAI_BASE_URL=http://127.0.0.1:<port>/api/v1 MOLOCHAI_API_KEY=mock-key
`;

function fail(message) {
  process.stderr.write(`molochai-mock: ${message}\n\n${HELP}`);
  process.exit(2);
}

function integer(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

let args;
try {
  args = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'delay-ms': { type: 'string' },
      unavailable: { type: 'string' },
      'rate-limit': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }).values;
} catch (err) {
  fail(err.message);
}

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const env = process.env;
const options = {
  port: integer('--port', args.port ?? env.MOCK_PORT, DEFAULTS.port),
  host: args.host ?? env.MOCK_HOST ?? DEFAULTS.host,
  delayMs: integer('--delay-ms', args['delay-ms'] ?? env.MOCK_DELAY_MS, DEFAULTS.delayMs),
  unavailable: args.unavailable ?? env.MOCK_UNAVAILABLE ?? '',
  rateLimit: integer('--rate-limit', args['rate-limit'] ?? env.MOCK_RATE_LIMIT, DEFAULTS.rateLimit),
  quiet: args.quiet,
};

for (const id of options.unavailable.split(',').map((s) => s.trim())) {
  if (id && !MODEL_IDS.includes(id)) {
    process.stderr.write(`molochai-mock: warning: unknown model id "${id}" in --unavailable\n`);
  }
}

let mock;
try {
  mock = await startMockServer(options);
} catch (err) {
  fail(`cannot listen on ${options.host}:${options.port}: ${err.message}`);
}

process.stdout.write(`MolochAI mock API listening on ${mock.baseUrl}\n`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    mock.close().then(() => process.exit(0));
  });
}
