import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempRoot() {
  return process.env.CLAUDEVILLE_TEST_TMPDIR || os.tmpdir();
}

export function makeTempDir(prefix) {
  const root = tempRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    return fs.mkdtempSync(path.join(root, prefix));
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      throw new Error(`cannot create temp dir under ${root}; set CLAUDEVILLE_TEST_TMPDIR to a writable directory`);
    }
    throw error;
  }
}
