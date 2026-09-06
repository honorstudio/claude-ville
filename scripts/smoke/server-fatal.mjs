import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDir } from '../tests/support/tmp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpHome = makeTempDir('claudeville-fatal-');
const watchedFile = path.join(tmpHome, 'watched.jsonl');
fs.writeFileSync(watchedFile, '{}\n');

const bootstrap = `
  const runtime = require('./claudeville/server.js');
  runtime._watcherTest.refreshWatchPaths([{
    type: 'file',
    path: ${JSON.stringify(watchedFile)},
    provider: 'claude',
    scope: 'discovery',
    kind: 'discovery'
  }]);
  runtime._watcherTest.installProcessHandlers();
  setImmediate(() => { throw new Error('fatal smoke sentinel'); });
`;

function runChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', bootstrap], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tmpHome,
        CLAUDEVILLE_DISABLE_GIT_ENRICHMENT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk) => { output += chunk.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`fatal child did not exit\n${output}`));
    }, 5000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  });
}

try {
  const result = await runChild();
  assert.equal(result.signal, null);
  assert.equal(result.code, 1, `expected fatal exit code 1\n${result.output}`);
  assert.match(result.output, /fatal smoke sentinel/);
  assert.match(result.output, /Shutting down server \(uncaughtException\)/);
  assert.match(result.output, /Server shutdown complete/);
  console.log('server fatal smoke passed (watcher cleanup, uncaughtException exit 1)');
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
