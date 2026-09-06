import test from 'node:test';
import assert from 'node:assert/strict';
import { astraWeaponPose } from '../../claudeville/src/presentation/character-mode/AstraWeaponPose.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { SpriteSheet, DIRECTIONS } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';

test('Astra wrists follow the rendered cell, independently of cape/crest bounds and world scale', () => {
    const sheet = new SpriteSheet(null);
    for (const [state, count] of [['walk', 6], ['idle', 4]]) {
        for (let direction = 0; direction < 8; direction++) {
            for (let frame = 0; frame < count; frame++) {
                const cell = sheet.cell(state, direction, frame);
                const pose = astraWeaponPose({ cell, dx: 0, dy: 0 }, DIRECTIONS[direction], 'runeblade');
                assert.ok(pose.x >= 30 && pose.x <= 60 && pose.y >= 50 && pose.y <= 62);
                const scaled = astraWeaponPose({ cell, dx: 100, dy: -50, drawScale: 2,
                    bounds: { minX: 0, maxX: 92, minY: 0, maxY: 92 } }, DIRECTIONS[direction], 'runeblade');
                assert.equal(scaled.x, 100 + pose.x * 2);
                assert.equal(scaled.y, -50 + pose.y * 2);
            }
        }
    }
    const pose = frame => astraWeaponPose({ cell: sheet.cell('walk', 2, frame), dx: 0, dy: 0 }, 'e', 'runeblade');
    assert.notDeepEqual(pose(1), pose(4), 'the moving wrist must not stay at one estimated position');
    assert.equal(astraWeaponPose({ dx: 0, dy: 0 }, 'e', 'runeblade'), null);
});

test('GPU baking passes all 80 source cells to the same equipment path used by Canvas', () => {
    const calls = [];
    const context = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {}, drawImage() {} };
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => ({ getContext: () => context }) };
    try {
        const sprite = {
            spriteCanvas: { width: 736, height: 920 },
            spriteSheet: { cellSize: 92 },
            // Deliberately different from the cells being baked.
            frame: 3, direction: 7, animState: 'idle',
            _getCellContentBounds: () => ({ minX: 20, maxX: 70, minY: 20, maxY: 75 }),
            _drawCodexEquipment(ctx, identity, geometry, layer, direction) {
                const pose = astraWeaponPose(geometry, direction, 'runeblade');
                assert.ok(pose, 'every baked frame needs its authored grip');
                calls.push(`${geometry.cell.sx}:${geometry.cell.sy}:${layer}:${direction}`);
            },
        };
        AgentSprite.prototype._composeGpuEquippedSheet.call(sprite, { spriteId: 'agent.codex.gpt6astra' });
        assert.equal(new Set(calls).size, 160);
        assert.ok(calls.includes('184:368:front:e'));
        assert.ok(calls.includes('0:552:back:s'));
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('Astra hides the far hand with its blade; unprofiled sprites keep their fallback poses', () => {
    const sprite = Object.create(AgentSprite.prototype);
    sprite.assets = { has: () => true };
    const calls = [];
    sprite._drawCodexAssetEquipment = (ctx, asset, geometry, direction, part) => {
        calls.push({ part, grip: geometry.authoredGrip });
    };
    const geometry = { cell: { sy: 552 }, dx: 0, dy: 0,
        bounds: { minX: 20, maxX: 70, minY: 20, maxY: 75 }, drawScale: 1 };
    const identity = { spriteId: 'agent.codex.gpt6astra', equipment: 'runeblade', codexHeavyGearBaked: true };
    sprite._drawCodexEquipment(null, identity, geometry, 'back', 'e');
    assert.deepEqual(calls.map(call => call.part), ['asset', 'hands']);
    assert.ok(calls.every(call => call.grip.behindBody));
    calls.length = 0;
    sprite._drawCodexEquipment(null, identity, geometry, 'front', 'e');
    assert.equal(calls.length, 0, 'no floating hand may be stamped over the torso');
    sprite._drawCodexEquipment(null, { ...identity, spriteId: 'agent.codex.unprofiled' }, geometry, 'front', 's');
    assert.deepEqual(calls.map(call => call.part), ['asset', 'hands']);
    assert.ok(calls.every(call => call.grip === null));
});
