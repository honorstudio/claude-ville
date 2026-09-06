import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../../tests/support/tmp.mjs';

const SUPPORT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SUPPORT_DIR, '../../..');
const SERVER_BOOTSTRAP = path.join(SUPPORT_DIR, '..', 'r1-18.server-bootstrap.cjs');
const SERVER_MODULE = path.join(REPO_ROOT, 'claudeville', 'server.js');
const STARTUP_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 12_000;

function recentOutput(value, chunk) {
  return `${value}${chunk}`.slice(-OUTPUT_LIMIT);
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (child.exitCode !== null) finish(true);
  });
}

function signalChildTree(child, signal) {
  if (!child) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else if (child.exitCode === null) child.kill(signal);
  } catch {
    // The child may have exited between the state check and the signal.
  }
}

async function stopChildTree(child) {
  if (!child) return;
  if (child.exitCode === null) {
    try {
      child.stdin.write('shutdown\n');
      child.stdin.end();
    } catch {
      // The child may already be exiting.
    }
  }
  const exitedGracefully = await waitForExit(child, 1_000);
  signalChildTree(child, 'SIGTERM');
  if (exitedGracefully) return;
  if (await waitForExit(child, 1_000)) return;
  signalChildTree(child, 'SIGKILL');
  if (!(await waitForExit(child, 1_000)) && child.exitCode === null) {
    throw new Error('Isolated server child tree did not exit after forced cleanup');
  }
}

export async function startIsolatedServer({ home, env } = {}) {
  const ownsHome = !home;
  const isolatedHome = home || makeTempDir('claudeville-server-');
  const binDir = path.join(isolatedHome, 'bin');
  const repositoryRoot = path.join(isolatedHome, 'repositories');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(repositoryRoot, { recursive: true });

  const child = spawn(process.execPath, [SERVER_BOOTSTRAP, SERVER_MODULE], {
    cwd: REPO_ROOT,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      PATH: binDir,
      XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
      XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
      CLAUDEVILLE_DISABLE_GIT_ENRICHMENT: '1',
      CLAUDEVILLE_REPOSITORY_SCAN_ROOT: repositoryRoot,
      CLAUDEVILLE_OPENCODE_CONFIG_DIR: path.join(isolatedHome, '.config', 'opencode'),
      CLAUDEVILLE_OPENCODE_STATE_DIR: path.join(isolatedHome, '.local', 'share', 'opencode'),
      CLAUDEVILLE_OPENCODE_DB: path.join(isolatedHome, '.local', 'share', 'opencode', 'opencode.db'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});

  let stdout = '';
  let stderr = '';
  let stdoutRemainder = '';
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    let failure = null;
    try {
      await stopChildTree(child);
    } catch (error) {
      failure = error;
    }
    if (ownsHome) {
      try {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      } catch (error) {
        failure ||= error;
      }
    }
    if (failure) throw failure;
  };

  try {
    const port = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const onLine = (line) => {
        if (line.startsWith('R1_18_SERVER_ERROR ')) {
          finish(new Error(`Isolated server could not listen: ${line.slice('R1_18_SERVER_ERROR '.length)}`));
          return;
        }
        const match = line.match(/^R1_18_READY (\d+)$/);
        if (!match) return;
        const assignedPort = Number(match[1]);
        if (!assignedPort) {
          finish(new Error('Isolated server reported port 0 instead of an assigned ephemeral port'));
        } else if (assignedPort === 4000) {
          finish(new Error('Isolated server selected port 4000; port redirection failed'));
        } else {
          finish(null, assignedPort);
        }
      };
      const timer = setTimeout(() => {
        finish(new Error(
          `Timed out waiting for isolated server readiness; stdout: ${stdout}; stderr: ${stderr}`,
        ));
      }, STARTUP_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout = recentOutput(stdout, chunk);
        const lines = `${stdoutRemainder}${chunk}`.split('\n');
        stdoutRemainder = lines.pop() || '';
        for (const line of lines) onLine(line.replace(/\r$/, ''));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = recentOutput(stderr, chunk);
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => {
        finish(new Error(
          `Isolated server exited before listening (code=${code}, signal=${signal}); stdout: ${stdout}; stderr: ${stderr}`,
        ));
      });
    });

    return {
      baseUrl: `http://127.0.0.1:${port}`,
      port,
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Isolated server startup and cleanup failed');
    }
    throw error;
  }
}
