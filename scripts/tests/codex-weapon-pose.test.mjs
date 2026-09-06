import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_GRIP_PROFILES, codexWeaponPose } from '../../claudeville/src/presentation/character-mode/CodexWeaponPose.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { Compositor } from '../../claudeville/src/presentation/character-mode/Compositor.js';
import { DIRECTIONS, SpriteSheet } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';
import { getModelVisualIdentity } from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';

test('every Codex body has a valid authored grip for every animation cell and effort', () => {
    const sheet = new SpriteSheet(null);
    for (const model of ['codex', 'gpt-5.3-codex', 'gpt-5-3-codex-spark', 'gpt-5.4', 'gpt-5.5',
        'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']) {
        for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
            const identity = getModelVisualIdentity(model, effort, 'codex');
            for (let dir = 0; dir < 8; dir++) for (let row = 0; row < 10; row++) {
                const cell = sheet.cell(row < 6 ? 'walk' : 'idle', dir, row < 6 ? row : row - 6);
                const pose = codexWeaponPose(identity.spriteId, { cell, dx: 0, dy: 0 }, DIRECTIONS[dir], identity.equipment);
                assert.ok(pose, `${model}/${effort}/${dir}/${row}`);
                assert.ok(Number.isInteger(pose.x) && pose.x > 0 && pose.x < 92);
                assert.ok(Number.isInteger(pose.y) && pose.y > 0 && pose.y < 92);
                assert.ok(Number.isFinite(pose.angle) && pose.scale > 0 && pose.scale <= 1);
                assert.ok(!pose.behindBody || pose.backLayer, 'hidden hands must carry the weapon behind the body');
                assert.equal(pose.palette.length, 4);
                assert.ok(pose.palette.every(color => /^#[\da-f]{6}$/i.test(color)));
                const scaled = codexWeaponPose(identity.spriteId, { cell, dx: 100, dy: -50, drawScale: 2,
                    bounds: { minX: 0, minY: 0, maxX: 92, maxY: 92 } }, DIRECTIONS[dir], identity.equipment);
                assert.equal(scaled.x, 100 + pose.x * 2);
                assert.equal(scaled.y, -50 + pose.y * 2);
            }
        }
    }
    for (const profile of Object.values(CODEX_GRIP_PROFILES)) {
        for (const direction of DIRECTIONS) assert.equal(profile.wrists[direction].length, 10);
    }
    assert.equal(codexWeaponPose('agent.claude.fable', {}, 's', 'runeblade'), null);
});

test('empty-handed Codex sheets preserve armor even when legacy policy requests color scrubbing', () => {
    for (const spriteId of ['agent.codex.base', 'agent.codex.gpt53spark', 'agent.codex.gpt54', 'agent.codex.gpt55',
        'agent.codex.gpt55.high', 'agent.codex.gpt55.xhigh']) {
        assert.equal(AgentSprite.prototype._shouldScrubBakedCodexWeapon({ spriteId, suppressBakedWeapon: true }), false);
    }
});

test('GPT-5.4 tool cleanup runs before crests can anchor to the detached wrench', () => {
    const order = [];
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => ({ getContext: () => ({
        drawImage: () => order.push('base'), clearRect: () => order.push('cleanup'),
    }) }) };
    try {
        const compositor = Object.create(Compositor.prototype);
        Object.assign(compositor, {
            assets: { get: () => ({}), getDims: () => ({ w: 736, h: 920 }) },
            cache: new Map(), cachePixels: 0,
            _resolvedVariantKey: () => '0', _trimCache() {},
            _applyPaletteSwap: () => order.push('palette'),
            _compositeAccessory: () => order.push('crest'),
        });
        compositor.spriteFor('agent.codex.gpt54', 'codex', 0, 'effortXhigh');
        assert.equal(order[0], 'base');
        assert.equal(order.filter(step => step === 'cleanup').length, 80);
        assert.deepEqual(order.slice(-2), ['palette', 'crest']);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('GPT-5.4 removes its detached upper-right wrench without color-keying hands or the helmet', () => {
    const rectangles = [];
    const ctx = { clearRect: (...rect) => rectangles.push(rect),
        getImageData() { assert.fail('brass/steel color scrubbing would erase the hands'); } };
    AgentSprite.prototype._clearBakedCodexSidearmPixels.call(AgentSprite.prototype, ctx, 736, 920, 'gpt54');
    assert.equal(rectangles.length, 80);
    const inside = (x, y, [rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h;
    for (let row = 0; row < 10; row++) for (let dir = 0; dir < 8; dir++) {
        const rect = rectangles[row * 8 + dir];
        assert.ok(inside(dir * 92 + 70, row * 92 + 25, rect), 'detached tool region must be removed');
        assert.ok(!inside(dir * 92 + 45, row * 92 + 30, rect), 'helmet must remain');
        assert.ok(!inside(dir * 92 + 35, row * 92 + 58, rect), 'brass hand must remain');
    }
});

test('authored engineer carry does not also draw the old floating back-wrench', () => {
    const sprite = Object.create(AgentSprite.prototype);
    sprite.assets = { has: () => true };
    sprite._drawWeaponAt = () => assert.fail('legacy back-wrench must not be drawn');
    sprite._drawCodexAssetEquipment = () => {};
    const identity = getModelVisualIdentity('gpt-5.4', 'none', 'codex');
    sprite._drawCodexEquipment(null, identity, { cell: { sy: 552 }, dx: 0, dy: 0, drawScale: 1,
        bounds: { minX: 20, minY: 20, maxX: 70, maxY: 80 } }, 'back', 'ne');
});
