#!/usr/bin/env node

// Adapter helper allowlist (derived from adapters/index.js and adapters/):
// dialogue.js, gitEvents.js, hooks.js, sessionPresentation.js, shared.js, toolResults.js, turnState.js.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'claudeville', 'adapters');
const CSS_DIR = path.join(REPO_ROOT, 'claudeville', 'css');
const ADAPTER_HELPERS = new Set([
  'dialogue.js',
  'gitEvents.js',
  'hooks.js',
  'sessionPresentation.js',
  'shared.js',
  'toolResults.js',
  'turnState.js',
]);
const REQUIRED_DIRECTORIES = [
  'claudeville/src/application',
  'claudeville/src/config',
  'claudeville/src/domain',
  'claudeville/src/infrastructure',
  'claudeville/src/presentation',
  'claudeville/src/presentation/character-mode',
  'claudeville/src/presentation/dashboard-mode',
  'claudeville/src/presentation/shared',
];
const FIXED_POSITION_ALLOWLIST = new Map([
  ['character.css', new Set(['.first-run-hint', '.world-grammar'])],
  ['layout.css', new Set(['.toast-container'])],
  ['modal.css', new Set(['.modal-overlay'])],
  ['topbar.css', new Set(['.topbar__connection-panel', '.topbar__spend-panel'])],
]);

const failures = [];
const read = relativePath => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
const fail = message => failures.push(message.replace(/[\r\n]+/g, ' '));

for (const directory of REQUIRED_DIRECTORIES) {
  if (!fs.existsSync(path.join(REPO_ROOT, directory))) fail(`missing layer directory: ${directory}`);
}

const packageJson = JSON.parse(read('package.json'));
if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) {
  fail(`package.json has runtime dependencies: ${Object.keys(packageJson.dependencies).sort().join(', ')}`);
}

const adapterIndex = read('claudeville/adapters/index.js');
const adapterImports = new Map();
const requirePattern = /const\s*\{([^}]+)\}\s*=\s*require\(['"]\.\/([^'"]+)['"]\)/g;
for (const match of adapterIndex.matchAll(requirePattern)) {
  const fileName = match[2].endsWith('.js') ? match[2] : `${match[2]}.js`;
  const constructors = match[1].split(',').map(value => value.trim().split(/\s+as\s+/)[0]);
  adapterImports.set(fileName, constructors.filter(name => name.endsWith('Adapter')));
}
const adapterFiles = fs.readdirSync(ADAPTER_DIR)
  .filter(fileName => fileName.endsWith('.js'))
  .filter(fileName => fileName !== 'index.js' && !ADAPTER_HELPERS.has(fileName))
  .sort();
for (const fileName of adapterFiles) {
  const constructors = adapterImports.get(fileName) || [];
  const registered = constructors.some(name => new RegExp(`\\bnew\\s+${name}\\s*\\(`).test(adapterIndex));
  if (!registered) fail(`unregistered adapter: claudeville/adapters/${fileName}`);
}

const serverSource = read('claudeville/server.js');
if (!/const\s+PORT\s*=\s*4000\s*;/.test(serverSource)) {
  fail('server bind contract: claudeville/server.js must define PORT as 4000');
}
if (!/const\s+LOOPBACK_HOST\s*=\s*['"]127\.0\.0\.1['"]\s*;/.test(serverSource)) {
  fail('server bind contract: claudeville/server.js must define LOOPBACK_HOST as 127.0.0.1');
}
if (!/\.listen\(\s*PORT\s*,\s*LOOPBACK_HOST\s*,/.test(serverSource)) {
  fail('server bind contract: claudeville/server.js must listen on PORT and LOOPBACK_HOST');
}

for (const fileName of fs.readdirSync(CSS_DIR).filter(name => name.endsWith('.css')).sort()) {
  const css = fs.readFileSync(path.join(CSS_DIR, fileName), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const allowedSelectors = FIXED_POSITION_ALLOWLIST.get(fileName) || new Set();
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/position\s*:\s*fixed\b/i.test(block[2])) continue;
    const selectors = block[1].split(',').map(selector => selector.trim().replace(/\s+/g, ' '));
    for (const selector of selectors) {
      if (!allowedSelectors.has(selector)) fail(`position: fixed is not allowlisted: claudeville/css/${fileName} selector ${selector}`);
    }
  }
}

const claudeTail = read('CLAUDE.md').split(/\r?\n/).slice(2).join('\n');
const agentsTail = read('AGENTS.md').split(/\r?\n/).slice(2).join('\n');
if (claudeTail !== agentsTail) fail('root parity mismatch: CLAUDE.md and AGENTS.md differ after line 2');

if (failures.length > 0) {
  for (const failure of failures) console.error(`architecture check failed: ${failure}`);
  process.exitCode = 1;
} else {
  console.log('architecture check passed');
}
