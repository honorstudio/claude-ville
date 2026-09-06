import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { AgentGpuOverlayRenderer } from '../../claudeville/src/presentation/character-mode/AgentGpuOverlayRenderer.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';

test('AgentSprite keeps compatibility entry points while delegating GPU overlay ownership', () => {
    const calls = [];
    const sprite = {
        gpuOverlayRenderer: {
            setEnabled(value) { calls.push(['enabled', value]); },
            getRecords() { calls.push(['records']); return ['record']; },
            draw(ctx, zoom, mode) { calls.push(['draw', ctx, zoom, mode]); },
            setFrameRecord(record) { calls.push(['frame', record]); },
        },
    };
    const ctx = {};

    AgentSprite.prototype.setGpuWorldEnabled.call(sprite, true);
    assert.deepEqual(AgentSprite.prototype.getGpuWorldRecords.call(sprite), ['record']);
    AgentSprite.prototype.drawGpuWorldOverlay.call(sprite, ctx, 0.75, 'compact');
    AgentSprite.prototype._setGpuFrameRecord.call(sprite, { cell: { sx: 1 } });

    assert.deepEqual(calls, [
        ['enabled', true],
        ['records'],
        ['draw', ctx, 0.75, 'compact'],
        ['frame', { cell: { sx: 1 } }],
    ]);
});

// The five body-frame marks have exactly one owner per backend: the Canvas body
// pass, or this resident overlay. Striking one twice compounds its alpha, and
// dropping one (stance, before this) silently costs the resident backend a cue.
test('the resident overlay strikes every body-frame mark exactly once, in Canvas order', () => {
    const marks = [];
    const frameGeometry = { dx: 4, dy: 6, bounds: { minX: 0, maxX: 92, minY: 0, maxY: 92 }, drawScale: 1 };
    const host = {
        agent: { id: 'work-1', provider: 'claude', status: 'working', isDeparted: false },
        gpuWorldEnabled: true,
        selected: false,
        hovered: false,
        chatting: false,
        motionScale: 1,
        overlaySlot: null,
        nameTagSlot: null,
        gpuActionOverlay: false,
        x: 100,
        y: 80,
        _gpuFrameRecord: { frameGeometry, contentTopY: 40 },
        _drawSignatureMark: (_ctx, geometry) => marks.push(['signature', geometry]),
        _drawReceiveBeat: (_ctx, geometry) => marks.push(['receive-beat', geometry]),
        _drawStanceOverlay: (_ctx, geometry) => marks.push(['stance', geometry]),
        _drawActionPoseOverlay: (_ctx, geometry) => marks.push(['action-pose', geometry]),
        _drawToolRitualOverlay: (_ctx, geometry) => marks.push(['tool-ritual', geometry]),
        _drawStatus: () => {},
        _drawStatusEmote: () => {},
        _drawPlanModeGlyph: () => {},
        _drawRetryGlyph: () => {},
        _drawCompactNameStatus: () => {},
        _drawNameTag: () => {},
    };
    const renderer = new AgentGpuOverlayRenderer(host);

    renderer.draw({}, 2, 'full');

    assert.deepEqual(marks.map(([name]) => name), [
        'signature',
        'receive-beat',
        'stance',
        'action-pose',
        'tool-ritual',
    ]);
    // Every mark reads the record's own frame geometry, so the resident body
    // and the Canvas body place the identical mark.
    assert.ok(marks.every(([, geometry]) => geometry === frameGeometry));
});

test('departed GPU records are dim, non-emissive, and retain the same source geometry', () => {
    const source = { width: 736, height: 736 };
    const host = {
        agent: { id: 'done-1', provider: 'codex', status: 'completed', isDeparted: true },
        gpuWorldEnabled: true,
        spriteCanvas: source,
        assets: { assetVersion: 'test' },
    };
    const renderer = new AgentGpuOverlayRenderer(host);
    renderer.setFrameRecord({
        cell: { sx: 4, sy: 5, sw: 92, sh: 92 },
        dx: 10,
        dy: 20,
        drawScale: 1.25,
        profileKey: 'profile',
        spriteId: 'agent.codex.base',
        alpha: 0.8,
    });

    assert.equal(host._gpuFrameRecord.alpha, 0.8 * 0.58);
    assert.equal(host._gpuFrameRecord.emissive, 0);
    assert.equal(host._gpuFrameRecord.width, 115);
    assert.equal(host._gpuFrameRecord.height, 115);
    assert.deepEqual(renderer.getRecords(), [host._gpuFrameRecord]);
});

test('departed plaque is an explicit static cue with a complete reduced-motion fallback', () => {
    const calls = [];
    const ctx = {
        save() {},
        restore() {},
        translate(...args) { calls.push(['translate', ...args]); },
        scale(...args) { calls.push(['scale', ...args]); },
        beginPath() {},
        roundRect(...args) { calls.push(['roundRect', ...args]); },
        fill() {},
        stroke() {},
        fillText(...args) { calls.push(['fillText', ...args]); },
    };
    const renderer = new AgentGpuOverlayRenderer({ x: 100.4, y: 50.4, motionScale: 0 });

    renderer.drawDepartedTreatment(ctx);

    assert.deepEqual(calls[0], ['translate', 100, 60]);
    assert.deepEqual(calls[1], ['scale', 1, 1]);
    assert.deepEqual(calls[2], ['roundRect', -29, 0, 58, 14, 3]);
    assert.deepEqual(calls[3], ['fillText', 'DEPARTED', 0, 7.5]);
});

test('departed sprites settle once and allocate no ongoing animation work', () => {
    let resetCount = 0;
    const sprite = {
        agent: { isDeparted: true },
        x: 12,
        y: 34,
        targetX: 90,
        targetY: 80,
        moving: true,
        chatting: true,
        chatPartner: {},
        _gossiping: true,
        waypoints: [{ x: 20, y: 40 }],
        frame: 3,
        isArrivalPending: () => false,
        _resetWalkCycle() { resetCount += 1; },
    };

    AgentSprite.prototype.update.call(sprite, null, 16);
    AgentSprite.prototype.update.call(sprite, null, 16);

    assert.equal(sprite.moving, false);
    assert.equal(sprite.chatting, false);
    assert.equal(sprite.chatPartner, null);
    assert.deepEqual(sprite.waypoints, []);
    assert.equal(sprite.targetX, 12);
    assert.equal(sprite.targetY, 34);
    assert.equal(sprite.animState, 'idle');
    assert.equal(sprite.frame, 0);
    assert.equal(resetCount, 1);
});

test('split preserves model-tier behaviour and Agent.speech as the sole copy authority', async () => {
    const source = await readFile(
        new URL('../../claudeville/src/presentation/character-mode/AgentSprite.js', import.meta.url),
        'utf8',
    );
    const overlaySource = await readFile(
        new URL('../../claudeville/src/presentation/character-mode/AgentGpuOverlayRenderer.js', import.meta.url),
        'utf8',
    );

    assert.match(source, /modelBehaviorProfile\(agent\?\.model, agent\?\.effort\)/);
    assert.match(source, /agent\.speech/);
    // The preset-pool era is over: the sprite must not reach for the old
    // bubbleText contract or manufacture its own line.
    assert.doesNotMatch(source, /agent\.bubbleText|visitIntentBubble/);
    assert.match(source, /this\.motionScale/);
    assert.doesNotMatch(overlaySource, /Math\.sin|setInterval|requestAnimationFrame/);
    assert.match(overlaySource, /static` motion/);
});
