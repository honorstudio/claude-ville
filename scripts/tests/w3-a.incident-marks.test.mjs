import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { compactIncidentMark } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';

const CHARACTER_MODE = '../../claudeville/src/presentation/character-mode/';

function readSource(file) {
    return readFileSync(new URL(CHARACTER_MODE + file, import.meta.url), 'utf8');
}

test('errored, rate_limited and waiting_on_user yield distinct primary incident shapes', () => {
    const errored = compactIncidentMark(AgentStatus.ERRORED);
    const quota = compactIncidentMark(AgentStatus.RATE_LIMITED);
    const needsYou = compactIncidentMark(AgentStatus.WAITING_ON_USER);

    assert.equal(errored.primary, true);
    assert.equal(quota.primary, true);
    assert.equal(needsYou.primary, true);
    assert.equal(errored.slot, 'incident');
    assert.equal(quota.slot, 'incident');
    assert.equal(needsYou.slot, 'incident');
    assert.equal(errored.shapeId, 'alert');
    assert.equal(quota.shapeId, 'hourglass');
    assert.equal(needsYou.shapeId, 'beacon');
    assert.notEqual(errored.shapeId, quota.shapeId);
    assert.notEqual(errored.shapeId, needsYou.shapeId);
    assert.notEqual(quota.shapeId, needsYou.shapeId);
});

test('working, idle, completed and waiting yield no incident mark', () => {
    for (const status of [
        AgentStatus.WORKING,
        AgentStatus.IDLE,
        AgentStatus.COMPLETED,
        AgentStatus.WAITING,
        'unknown',
        null,
    ]) {
        assert.equal(compactIncidentMark(status), null, String(status));
    }
});

test('reduced motion yields a static descriptor with no animation phase', () => {
    for (const status of [
        AgentStatus.ERRORED,
        AgentStatus.RATE_LIMITED,
        AgentStatus.WAITING_ON_USER,
    ]) {
        const reduced = compactIncidentMark(status, { motionScale: 0 });
        const moving = compactIncidentMark(status, { motionScale: 1 });
        assert.equal(reduced.static, true);
        assert.equal('animationPhase' in reduced, false);
        assert.equal(reduced.animationPhase, undefined);
        // Same frozen descriptor either way: overview never allocates a pulse.
        assert.equal(reduced, moving);
    }
});

// AgentSprite.js and AgentGpuOverlayRenderer.js are canvas-coupled: importing
// them exercises module init, but the draw() paths cannot be executed in
// plain Node without a DOM stub. Source-contract assertions are the check
// that overview zoom actually *calls* the helper. Technique: read the files
// as text, extract the `zoom < 1` early-return block, and require the shared
// helper name to appear before that `return` — the previous defect was that
// the branch returned after the impostor/beacon/tool glyph and skipped the
// status emotes defined later in the full-body path.
test('low-zoom canvas branch draws incident marks before returning, and both paths share the helper', () => {
    const spriteSource = readSource('AgentSprite.js');
    const overlaySource = readSource('AgentGpuOverlayRenderer.js');

    assert.match(spriteSource, /bucketForStatus/);
    assert.match(spriteSource, /export function compactIncidentMark/);
    assert.match(spriteSource, /export function drawCompactIncidentMark/);

    const lowZoom = spriteSource.match(
        /if\s*\(\s*!this\.selected\s*&&\s*zoom\s*<\s*1\s*\)\s*\{[\s\S]*?\n            return;/,
    );
    assert.ok(lowZoom, 'low-zoom early-return branch must still exist');
    assert.match(lowZoom[0], /compactIncidentMark/);
    assert.match(lowZoom[0], /drawCompactIncidentMark/);
    assert.doesNotMatch(lowZoom[0], /_drawStatusEmote/);
    const helperAt = lowZoom[0].indexOf('drawCompactIncidentMark');
    const returnAt = lowZoom[0].lastIndexOf('return');
    assert.ok(helperAt >= 0 && helperAt < returnAt, 'incident marks must be drawn before the low-zoom return');

    assert.match(overlaySource, /compactIncidentMark/);
    assert.match(overlaySource, /drawCompactIncidentMark/);
});
