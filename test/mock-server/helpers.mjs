// Shared helpers for the mock server tests.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServer } from '../../mock-server/app.mjs';

export const SERVER_PATH = fileURLToPath(new URL('../../mock-server/server.mjs', import.meta.url));
export const KEY = 'mock-key';

/** Start an in-process mock on a free port. Logs go to `mock.logs`. */
export async function startMock(options = {}) {
  const logs = [];
  const mock = await startMockServer({
    port: 0,
    delayMs: 0,
    log: (line) => logs.push(line),
    ...options,
  });
  mock.logs = logs;
  return mock;
}

/** Each test file gets its own server, so counters and rate windows never leak. */
let seq = 0;
export function unique(label = 'msg') {
  seq += 1;
  return `${label} ${process.pid}-${Date.now()}-${seq}`;
}

export function authHeaders(token = KEY) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export function postChat(baseUrl, body, { token = KEY, signal } = {}) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(token),
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

export function userChat(content, extra = {}) {
  return {
    model: 'glm-5.3-flash',
    messages: [{ role: 'user', content }],
    ...extra,
  };
}

/**
 * Parse an SSE body into events.
 * @returns {Promise<Array<{kind: 'comment', text: string} | {kind: 'data', raw: string, json?: any}>>}
 */
export async function readEvents(response) {
  const text = await response.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line === '') continue;
      if (line.startsWith(':')) {
        events.push({ kind: 'comment', text: line.slice(1).trim() });
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        events.push(raw === '[DONE]' ? { kind: 'data', raw } : { kind: 'data', raw, json: JSON.parse(raw) });
      } else {
        throw new Error(`unexpected SSE line: ${line}`);
      }
    }
  }
  return events;
}

/** Join the `delta.content` pieces of a parsed stream. */
export function streamedContent(events) {
  return events
    .filter((e) => e.json?.choices?.length)
    .map((e) => e.json.choices[0].delta.content ?? '')
    .join('');
}

export function streamedReasoning(events) {
  return events
    .filter((e) => e.json?.choices?.length)
    .map((e) => e.json.choices[0].delta.reasoning_content ?? '')
    .join('');
}

/**
 * Run server.mjs as a child process and wait for its "listening" line.
 * @returns {Promise<{child, baseUrl: string, stdout: string[], stderr: string[], stop: () => Promise<void>}>}
 */
export function spawnMock(args = [], env = {}) {
  const child = spawn(process.execPath, [SERVER_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stderr.setEncoding('utf8').on('data', (d) => stderr.push(...d.split('\n').filter(Boolean)));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock did not start: ${stderr.join('\n')}`)), 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`mock exited with ${code}: ${stderr.join('\n')}`));
    });
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout.push(...d.split('\n').filter(Boolean));
      const line = stdout.find((l) => l.startsWith('MolochAI mock API listening on '));
      if (!line) return;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      resolve({
        child,
        baseUrl: line.slice('MolochAI mock API listening on '.length).trim(),
        stdout,
        stderr,
        stop: () =>
          new Promise((done) => {
            if (child.exitCode !== null) return done();
            child.once('exit', () => done());
            child.kill();
          }),
      });
    });
  });
}

/** Run server.mjs to completion (for --help and bad flags). */
export function runMock(args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr += d;
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
