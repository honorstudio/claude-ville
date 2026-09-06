#!/usr/bin/env node

const { readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = join(__dirname, '..');
const targets = process.argv.slice(2);
const exts = new Set(['.js', '.cjs', '.mjs']);

if (!targets.length) {
  console.error('usage: node scripts/check-syntax.cjs <file-or-directory> [...]');
  process.exit(2);
}

function hasJsExt(file) {
  return [...exts].some((ext) => file.endsWith(ext));
}

function collect(target, files = []) {
  const abs = join(repoRoot, target);
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    for (const name of readdirSync(abs).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      collect(join(target, name), files);
    }
  } else if (stat.isFile() && hasJsExt(target)) {
    files.push(abs);
  }
  return files;
}

const files = targets.flatMap((target) => collect(target));
let failures = 0;

for (const file of files) {
  const rel = relative(repoRoot, file);
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failures++;
    process.stderr.write(`SYNTAX FAIL: ${rel}\n`);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stderr.write(result.stdout);
  }
}

if (failures) {
  console.error(`syntax check failed: ${failures}/${files.length} files`);
  process.exit(1);
}

console.log(`syntax check passed: ${files.length} files`);
