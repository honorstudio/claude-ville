import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

test('every top-level smoke script appears in the smoke catalog', () => {
    const catalog = read('scripts/smoke/README.md');
    const names = fs.readdirSync(path.join(REPO_ROOT, 'scripts', 'smoke'))
        .filter((name) => name.endsWith('.mjs'));
    for (const name of names) assert.ok(catalog.includes(`\`${name}\``), `missing smoke catalog row for ${name}`);
});

test('every verification npm script appears in a verification catalog', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    const catalogs = `${read('scripts/tests/README.md')}\n${read('scripts/smoke/README.md')}`;
    const prefixes = ['check:', 'test:', 'verify:', 'models:', 'release:', 'validate:', 'gate:'];
    for (const name of Object.keys(scripts).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))) {
        assert.ok(catalogs.includes(`\`${name}\``), `missing verification catalog entry for ${name}`);
    }
});

test('every docs markdown file appears in the docs index', () => {
    const index = read('docs/README.md');
    const names = fs.readdirSync(path.join(REPO_ROOT, 'docs')).filter((name) => name.endsWith('.md'));
    for (const name of names) assert.ok(index.includes(name), `missing docs index entry for ${name}`);
});
