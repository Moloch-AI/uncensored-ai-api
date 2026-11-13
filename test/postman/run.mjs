// Run the Postman collection with newman against the mock server.
//
//   npm run test:postman
//
// 1. Checks the collection and the environments: valid JSON in Postman's
//    format, and no API key stored in them.
// 2. Runs every request with the mock environment, on a fresh mock.
// 3. Runs again with the MolochAI API environment pointed at a fresh mock: this
//    is what a run against the real API executes. The mock-only folder must be
//    skipped and everything else must pass.
//
// newman is not a devDependency: npx fetches the pinned version below on the
// first run, so this needs network once. The mock runs in-process on a free
// port, so nothing else may be listening on 4010.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, startMockServer } from '../../mock-server/app.mjs';

const NEWMAN = 'newman@6.2.3';
const COLLECTION_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const MOCK_ONLY_FOLDER = 'Mock only ([mock:*] markers and special keys)';

const path = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const files = {
  collection: path('postman/MolochAI.postman_collection.json'),
  mockEnv: path('postman/mock.postman_environment.json'),
  apiEnv: path('postman/molochai.postman_environment.json'),
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const envValues = (env) => Object.fromEntries(env.values.map((v) => [v.key, v]));

/** All requests as {name, mockOnly, item}, depth first. */
function requests(items, mockOnly = false) {
  return items.flatMap((item) =>
    item.item ? requests(item.item, mockOnly || item.name === MOCK_ONLY_FOLDER) : [{ name: item.name, mockOnly, item }],
  );
}

function checkFiles() {
  const collection = readJson(files.collection);
  const mockEnv = readJson(files.mockEnv);
  const apiEnv = readJson(files.apiEnv);

  assert.equal(collection.info.schema, COLLECTION_SCHEMA, 'collection format v2.1');
  assert.deepEqual(collection.auth, {
    type: 'bearer',
    bearer: [{ key: 'token', value: '{{apiKey}}', type: 'string' }],
  });
  const variables = Object.fromEntries(collection.variable.map((v) => [v.key, v.value]));
  assert.equal(variables.baseUrl, 'https://api.molochai.dev/api/v1');
  assert.ok(!('apiKey' in variables), 'the API key belongs in an environment, not in the collection');

  const all = requests(collection.item);
  assert.ok(
    all.some((r) => r.mockOnly),
    `folder "${MOCK_ONLY_FOLDER}" exists`,
  );
  for (const { name, mockOnly, item } of all) {
    assert.ok(
      item.event?.some((e) => e.listen === 'test'),
      `"${name}" has tests`,
    );
    const auth = item.request.auth;
    if (!auth) continue; // inherits {{apiKey}}
    if (auth.type === 'noauth') continue;
    const token = auth.bearer?.find((p) => p.key === 'token')?.value ?? '';
    assert.ok(mockOnly && token.startsWith('mock-'), `"${name}": only mock-only requests set their own token`);
  }

  const mock = envValues(mockEnv);
  assert.equal(mock.baseUrl.value, `http://${DEFAULTS.host}:${DEFAULTS.port}/api/v1`, 'mock env matches the default');
  assert.equal(mock.apiKey.value, 'mock-key');
  assert.equal(mock.isMock.value, 'true');

  const api = envValues(apiEnv);
  assert.equal(api.baseUrl.value, 'https://api.molochai.dev/api/v1');
  assert.equal(api.apiKey.value, '', 'never commit a real key');
  assert.equal(api.apiKey.type, 'secret');
  assert.ok(!('isMock' in api));

  console.log(`ok    files: ${all.length} requests, ${all.filter((r) => r.mockOnly).length} of them mock only`);
  return all;
}

function newman(args) {
  const argv = ['--yes', NEWMAN, 'run', ...args];
  // On Windows npx is a .cmd script, which needs a shell. Quote the arguments
  // (none contains a quote) but not the command: cmd.exe resolves %~dp0 wrongly
  // in a batch file started by a quoted name.
  const child =
    process.platform === 'win32'
      ? spawn(`npx ${argv.map((arg) => `"${arg}"`).join(' ')}`, { stdio: 'inherit', shell: true })
      : spawn('npx', argv, { stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

async function pass(label, envFile, extraVars, reportFile) {
  const mock = await startMockServer({ port: 0, delayMs: 0, quiet: true });
  try {
    const vars = { baseUrl: mock.baseUrl, ...extraVars };
    const code = await newman([
      files.collection,
      '--environment',
      envFile,
      ...Object.entries(vars).flatMap(([key, value]) => ['--env-var', `${key}=${value}`]),
      '--timeout-request',
      '30000',
      '--reporters',
      'cli,json',
      '--reporter-json-export',
      reportFile,
    ]);
    if (!existsSync(reportFile)) {
      console.log(`FAIL  ${label}: newman did not run (exit code ${code})`);
      return { code, executed: [], assertions: { total: 0, failed: 0 }, failures: 1 };
    }
    const { run } = readJson(reportFile);
    const summary = {
      code,
      executed: run.executions.map((e) => e.item.name),
      assertions: run.stats.assertions,
      failures: run.failures.length,
    };
    console.log(
      `${summary.code === 0 && summary.failures === 0 ? 'ok   ' : 'FAIL '} ${label}: ` +
        `${summary.executed.length} requests, ${summary.assertions.total} assertions, ` +
        `${summary.assertions.failed} failed (newman exit code ${code})`,
    );
    return summary;
  } finally {
    await mock.close();
  }
}

const all = checkFiles();
const reports = mkdtempSync(join(tmpdir(), 'molochai-newman-'));
let failed = false;
try {
  const mockRun = await pass('mock environment', files.mockEnv, {}, join(reports, 'mock.json'));
  failed ||= mockRun.code !== 0 || mockRun.failures > 0;
  if (mockRun.executed.length !== all.length) {
    failed = true;
    console.log(`FAIL  expected all ${all.length} requests to run with the mock environment`);
  }

  const apiRun = await pass(
    'MolochAI API environment pointed at the mock',
    files.apiEnv,
    { apiKey: 'mock-key' },
    join(reports, 'api.json'),
  );
  const expected = all.filter((r) => !r.mockOnly).map((r) => r.name);
  failed ||= apiRun.code !== 0 || apiRun.failures > 0;
  if (JSON.stringify(apiRun.executed) !== JSON.stringify(expected)) {
    failed = true;
    console.log(`FAIL  expected only the requests outside the mock-only folder to run:\n  ${expected.join('\n  ')}`);
  } else {
    console.log(`ok    the mock-only folder was skipped (${all.length - expected.length} requests)`);
  }
} finally {
  rmSync(reports, { recursive: true, force: true });
}

if (failed) {
  console.error('Postman collection checks failed');
  process.exitCode = 1;
} else {
  console.log('all Postman collection checks passed');
}
