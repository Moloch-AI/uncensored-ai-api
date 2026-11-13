// Run the repository's mock server as a subprocess on a free port.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../../mock-server/server.mjs', import.meta.url));
const PREFIX = 'MolochAI mock API listening on ';

/** @returns {Promise<{baseUrl: string, stop: () => Promise<void>}>} */
export function startMock(...args) {
  const child = spawn(process.execPath, [SERVER, '--port', '0', '--delay-ms', '0', '--quiet', ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    child.once('exit', (code) => reject(new Error(`mock exited with ${code}`)));
    child.stdout.setEncoding('utf8').on('data', (data) => {
      out += data;
      const line = out.split('\n').find((l) => l.startsWith(PREFIX));
      if (!line) return;
      child.removeAllListeners('exit');
      resolve({
        baseUrl: line.slice(PREFIX.length).trim(),
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
