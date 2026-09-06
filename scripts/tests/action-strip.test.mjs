import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { DIRECTIONS, resolveActionFrame } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';
import {
    actionStripMismatch,
    actionStripPathFor,
} from '../../claudeville/src/presentation/character-mode/AssetManager.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const spritesRoot = path.join(repoRoot, 'claudeville/assets/sprites');
const manifest = yaml.load(fs.readFileSync(path.join(spritesRoot, 'manifest.yaml'), 'utf8'));
const characters = manifest.characters || [];

const PILOT = {
    path: 'characters/agent.claude.sonnet/actions.png',
    cell: 92,
    groups: {
        read: { rows: [0, 3], hold: 3 },
        wait: { rows: [4, 4], hold: 4 },
    },
    grip: { hand: 'both', sheathe: true },
};

test('a named group resolves one cell per direction and frame', () => {
    assert.deepEqual(resolveActionFrame(PILOT, 'read', 0, 0), { sx: 0, sy: 0, sw: 92, sh: 92 });
    // Direction is the column; the group's first row is the frame origin.
    assert.deepEqual(resolveActionFrame(PILOT, 'read', 6, 2), { sx: 6 * 92, sy: 2 * 92, sw: 92, sh: 92 });
    assert.deepEqual(resolveActionFrame(PILOT, 'wait', 3, 0), { sx: 3 * 92, sy: 4 * 92, sw: 92, sh: 92 });
    // A direction key resolves to the same column as its index.
    for (let index = 0; index < DIRECTIONS.length; index++) {
        assert.deepEqual(
            resolveActionFrame(PILOT, 'read', DIRECTIONS[index], 1),
            resolveActionFrame(PILOT, 'read', index, 1),
        );
    }
});

test('frames wrap inside their group and never leak into the next one', () => {
    assert.deepEqual(resolveActionFrame(PILOT, 'read', 0, 4), resolveActionFrame(PILOT, 'read', 0, 0));
    assert.deepEqual(resolveActionFrame(PILOT, 'read', 0, -1), resolveActionFrame(PILOT, 'read', 0, 3));
    // The single-row wait group holds no matter which frame is asked for.
    for (const frame of [0, 1, 7, 40]) {
        assert.equal(resolveActionFrame(PILOT, 'wait', 0, frame).sy, 4 * 92);
    }
});

test("frame 'hold' selects the declared static row, falling back to the last row", () => {
    assert.equal(resolveActionFrame(PILOT, 'read', 0, 'hold').sy, 3 * 92);
    assert.equal(resolveActionFrame(PILOT, 'wait', 0, 'hold').sy, 4 * 92);
    const noHold = { ...PILOT, groups: { read: { rows: [0, 3] } } };
    assert.equal(resolveActionFrame(noHold, 'read', 0, 'hold').sy, 3 * 92);
    const outOfRange = { ...PILOT, groups: { read: { rows: [0, 3], hold: 9 } } };
    assert.equal(resolveActionFrame(outOfRange, 'read', 0, 'hold').sy, 3 * 92);
});

test('a missing strip, unknown group, or bad direction resolves to null', () => {
    assert.equal(resolveActionFrame(undefined, 'read', 0, 0), null);
    assert.equal(resolveActionFrame(null, 'read', 0, 0), null);
    assert.equal(resolveActionFrame(PILOT, 'shout', 0, 0), null);
    assert.equal(resolveActionFrame(PILOT, 'read', 8, 0), null);
    assert.equal(resolveActionFrame(PILOT, 'read', -1, 0), null);
    assert.equal(resolveActionFrame(PILOT, 'read', 'up', 0), null);
    assert.equal(resolveActionFrame(PILOT, 'read', 0, Number.NaN), null);
    assert.equal(resolveActionFrame({ ...PILOT, cell: 0 }, 'read', 0, 0), null);
    assert.equal(resolveActionFrame({ ...PILOT, groups: { read: { rows: [3, 0] } } }, 'read', 0, 0), null);
});

test('strip paths stay sprites-root relative however they are declared', () => {
    assert.equal(actionStripPathFor(PILOT), 'assets/sprites/characters/agent.claude.sonnet/actions.png');
    assert.equal(
        actionStripPathFor({ path: 'assets/sprites/characters/x/actions.png' }),
        'assets/sprites/characters/x/actions.png',
    );
    assert.equal(actionStripPathFor({}), null);
    assert.equal(actionStripPathFor({ path: '   ' }), null);
});

test('a strip whose pixels cannot serve its groups is refused', () => {
    const good = { width: 8 * 92, height: 5 * 92 };
    assert.equal(actionStripMismatch(PILOT, good), null);
    assert.match(actionStripMismatch(PILOT, { width: 7 * 92, height: 5 * 92 }), /width/);
    assert.match(actionStripMismatch(PILOT, { width: 8 * 92, height: 5 * 92 + 3 }), /whole 92px rows/);
    // The declared wait row must exist in the PNG.
    assert.match(actionStripMismatch(PILOT, { width: 8 * 92, height: 4 * 92 }), /groups.wait/);
    assert.match(actionStripMismatch({ ...PILOT, groups: {} }, good), /groups is empty/);
});

test('every declared action strip exists at the engine cell and covers its groups', () => {
    const declared = characters.filter((entry) => entry.actionStrip);
    assert.ok(declared.length > 0, 'the pilot characters must declare action strips');
    for (const entry of declared) {
        const strip = entry.actionStrip;
        const file = path.join(spritesRoot, strip.path);
        assert.ok(fs.existsSync(file), `${entry.id} strip PNG missing at ${strip.path}`);
        // IHDR width/height without decoding the whole image.
        const header = fs.readFileSync(file).subarray(16, 24);
        const width = header.readUInt32BE(0);
        const height = header.readUInt32BE(4);
        assert.equal(strip.cell, 92, `${entry.id} strip must use the 92px engine cell`);
        assert.equal(width, 8 * strip.cell, `${entry.id} strip needs 8 direction columns`);
        const rows = height / strip.cell;
        assert.ok(Number.isInteger(rows), `${entry.id} strip height is not whole cells`);
        for (const [name, group] of Object.entries(strip.groups)) {
            assert.ok(group.rows[1] < rows, `${entry.id} group ${name} points past the strip`);
            const frame = resolveActionFrame(strip, name, 7, 'hold');
            assert.ok(frame.sy + frame.sh <= height, `${entry.id} group ${name} hold row is outside the PNG`);
        }
    }
});
