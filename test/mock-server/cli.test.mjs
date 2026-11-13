// The command-line entry (bin molochai-mock), run as a real child process.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { authHeaders, postChat, runMock, SERVER_PATH, spawnMock, userChat } from './helpers.mjs';

describe('server.mjs', () => {
  test('starts with a shebang so it works as an npm bin', () => {
    const first = readFileSync(SERVER_PATH, 'utf8').split('\n')[0];
    assert.equal(first, '#!/usr/bin/env node');
  });

  test('package.json exposes it as molochai-mock', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.bin['molochai-mock'], 'mock-server/server.mjs');
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.dependencies ?? {}, {}, 'the mock has no runtime dependencies');
    assert.ok(pkg.files.includes('mock-server/'));
  });

  test('prints the listening line, serves /health, logs requests to stderr', async () => {
    const mock = await spawnMock(['--port', '0', '--delay-ms', '0']);
    try {
      assert.match(mock.stdout[0], /^MolochAI mock API listening on http:\/\/127\.0\.0\.1:\d+\/api\/v1$/);
      const origin = mock.baseUrl.replace(/\/api\/v1$/, '');
      const res = await fetch(`${origin}/health`);
      assert.deepEqual(await res.json(), { ok: true });
      await (await postChat(mock.baseUrl, userChat('hi', { stream: true }))).text();
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(mock.stderr.includes('GET /health 200'), mock.stderr.join('\n'));
      assert.ok(mock.stderr.includes('POST /api/v1/chat/completions 200 glm-5.3-flash stream'), mock.stderr.join('\n'));
    } finally {
      await mock.stop();
    }
  });

  test('--quiet logs nothing', async () => {
    const mock = await spawnMock(['--port', '0', '--quiet']);
    try {
      await (await fetch(`${mock.baseUrl}/models`, { headers: authHeaders() })).text();
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(mock.stderr, []);
    } finally {
      await mock.stop();
    }
  });

  test('--unavailable and --rate-limit flags', async () => {
    const mock = await spawnMock([
      '--port',
      '0',
      '--quiet',
      '--unavailable',
      'glm-5.3-flash,gemma4-26b-a4b-qat',
      '--rate-limit',
      '5',
    ]);
    try {
      const res = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders() });
      assert.equal(res.headers.get('x-ratelimit-limit'), '5');
      const { data } = await res.json();
      const unavailable = data.filter((m) => !m.available).map((m) => m.id);
      assert.deepEqual(unavailable, ['glm-5.3-flash', 'gemma4-26b-a4b-qat']);
      const chat = await postChat(mock.baseUrl, userChat('hi'));
      assert.equal(chat.status, 503);
      assert.equal((await chat.json()).error.type, 'model_unavailable');
    } finally {
      await mock.stop();
    }
  });

  test('environment variables work like the flags', async () => {
    const mock = await spawnMock([], {
      MOCK_PORT: '0',
      MOCK_HOST: '127.0.0.1',
      MOCK_DELAY_MS: '0',
      MOCK_UNAVAILABLE: 'llama-3.3-70b-instruct-abliterated',
      MOCK_RATE_LIMIT: '7',
    });
    try {
      const res = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders() });
      assert.equal(res.headers.get('x-ratelimit-limit'), '7');
      const { data } = await res.json();
      assert.equal(data.find((m) => m.id === 'llama-3.3-70b-instruct-abliterated').available, false);
    } finally {
      await mock.stop();
    }
  });

  test('flags win over environment variables', async () => {
    const mock = await spawnMock(['--port', '0', '--quiet', '--rate-limit', '9'], { MOCK_RATE_LIMIT: '7' });
    try {
      const res = await fetch(`${mock.baseUrl}/models`, { headers: authHeaders() });
      assert.equal(res.headers.get('x-ratelimit-limit'), '9');
    } finally {
      await mock.stop();
    }
  });

  test('--help prints usage and exits 0', async () => {
    const { code, stdout } = await runMock(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: molochai-mock/);
    assert.match(stdout, /--unavailable/);
  });

  test('bad flags exit 2 with a message', async () => {
    const unknown = await runMock(['--nope']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /molochai-mock:/);
    const badPort = await runMock(['--port', 'abc']);
    assert.equal(badPort.code, 2);
    assert.match(badPort.stderr, /--port must be a non-negative integer/);
  });

  test('an unknown --unavailable id is reported on stderr', async () => {
    const mock = await spawnMock(['--port', '0', '--unavailable', 'gpt-4o']);
    try {
      await new Promise((r) => setTimeout(r, 100)); // stderr and stdout are separate pipes
      assert.ok(
        mock.stderr.some((l) => l.includes('unknown model id "gpt-4o"')),
        mock.stderr.join('\n'),
      );
    } finally {
      await mock.stop();
    }
  });
});
