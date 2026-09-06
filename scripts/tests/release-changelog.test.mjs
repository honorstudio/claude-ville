import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
    extractReleaseSection,
    parseReleaseHeader,
} from '../release/changelog.mjs';
import {
    inspectRelease,
    prepareRelease,
    verifyRelease,
} from '../release/prepare.mjs';
import { makeTempDir } from './support/tmp.mjs';

const roots = [];

after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(changelog, packageVersion = '0.38.0', uiVersion = 'v0.38') {
    const root = makeTempDir('claudeville-release-test-');
    roots.push(root);
    mkdirSync(join(root, 'claudeville'));
    writeFileSync(join(root, 'CHANGELOG.md'), changelog);
    writeFileSync(join(root, 'package.json'), `{
  "name": "fixture",
  "version": "${packageVersion}"
}\n`);
    writeFileSync(join(root, 'claudeville/index.html'),
        `<span class="topbar__version" tabindex="0">${uiVersion}</span>\n`);
    return root;
}

test('parses a named release header', () => {
    assert.deepEqual(
        parseReleaseHeader('## v0.40.0 — *River Roads* · Sep 03, 2026'),
        {
            version: '0.40.0',
            type: 'named',
            name: 'River Roads',
            date: 'Sep 03, 2026',
            hasDateRange: false,
        }
    );
});

test('parses a hotfix header', () => {
    assert.deepEqual(
        parseReleaseHeader('## v0.40.0.1 · Sep 03, 2026 — Hotfix'),
        {
            version: '0.40.0.1',
            type: 'hotfix',
            name: 'Hotfix',
            date: 'Sep 03, 2026',
            hasDateRange: false,
        }
    );
});

test('extracts exactly one release section at its boundary', () => {
    const text = `# Changelog

---

## v0.40.0 — *River Roads* · Sep 03, 2026

First notes.

---

## v0.39.1 — *Titan Tides* · Sep 02, 2026

Older notes.
`;
    assert.equal(
        extractReleaseSection(text, '0.40.0'),
        `## v0.40.0 — *River Roads* · Sep 03, 2026

First notes.\n`
    );
    assert.equal(extractReleaseSection(text, '0.41.0'), null);
});

test('rejects a requested version that does not match the top entry', () => {
    const root = fixture(`## v0.40.0 — *River Roads* · Sep 03, 2026\n`);
    assert.throws(() => inspectRelease(root, '0.39.0'), /not 0\.39\.0/);
});

test('rejects a malformed top release header', () => {
    const root = fixture(`## Release v0.40.0 - River Roads - Sep 03, 2026\n`);
    assert.throws(() => inspectRelease(root, '0.40.0'), /Malformed top CHANGELOG header/);
});

test('parses historical date ranges but rejects one as the top entry', () => {
    const header = '## v0.5.1.1 · May 5–16, 2026 — Hotfix';
    assert.equal(parseReleaseHeader(header)?.hasDateRange, true);
    assert.equal(
        parseReleaseHeader('## v0.2.0 — *The Town Crier* · Feb 19–23, 2026')?.hasDateRange,
        true
    );
    const root = fixture(`${header}\n`);
    assert.throws(() => inspectRelease(root, '0.5.1.1'), /single date/);
});

test('dry-run is read-only and write mode updates both versions and exact notes', () => {
    const changelog = `# Changelog

---

## v0.40.0 — *River Roads* · Sep 03, 2026

Release body.

---

## v0.39.0 — *Old Road* · Sep 02, 2026

Old body.\n`;
    const root = fixture(changelog);
    const packagePath = join(root, 'package.json');
    const indexPath = join(root, 'claudeville/index.html');
    const packageBefore = readFileSync(packagePath, 'utf8');
    const indexBefore = readFileSync(indexPath, 'utf8');

    const dryRun = prepareRelease(root, '0.40.0');
    assert.equal(readFileSync(packagePath, 'utf8'), packageBefore);
    assert.equal(readFileSync(indexPath, 'utf8'), indexBefore);
    assert.equal(dryRun.notes, extractReleaseSection(changelog, '0.40.0'));

    const written = prepareRelease(root, '0.40.0', { write: true, notesDirectory: root });
    assert.match(readFileSync(packagePath, 'utf8'), /"version": "0\.40\.0"/);
    assert.match(readFileSync(indexPath, 'utf8'), />v0\.40<\/span>/);
    assert.equal(readFileSync(written.notesPath, 'utf8'), written.notes);
    assert.equal(verifyRelease(root).release.version, '0.40.0');
});
