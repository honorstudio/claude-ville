import test from 'node:test';
import assert from 'node:assert/strict';

import { VillageDirector } from '../../claudeville/src/presentation/character-mode/VillageDirector.js';
import { drawVillageDirectorScreen } from '../../claudeville/src/presentation/character-mode/VillageDirectorOverlay.js';

function scene(index, now, type = 'incident') {
    return {
        id: `scene-${index}`,
        type,
        kind: `kind-${index}`,
        label: `Scene ${index}`,
        startedAt: now,
        expiresAt: now + 10_000,
    };
}

function fakeContext() {
    const calls = [];
    return {
        calls,
        save() { calls.push(['save']); },
        restore() { calls.push(['restore']); },
        measureText(text) { return { width: String(text).length * 6 }; },
        fillRect(...args) { calls.push(['fillRect', ...args]); },
        strokeRect(...args) { calls.push(['strokeRect', ...args]); },
        fillText(...args) { calls.push(['fillText', ...args]); },
    };
}

test('keeps eight render scenes and summarizes every concurrent overflow', () => {
    const director = new VillageDirector({ buildings: new Map() });
    const now = Date.now();
    for (let index = 0; index < 11; index++) director._addScene(scene(index, now));

    const snapshot = director.update(null, 16, now);
    assert.equal(director.scenes.length, 8);
    assert.equal(snapshot.activeSceneCount, 8);
    assert.deepEqual(snapshot.sceneOverflow, {
        count: 3,
        incidentCount: 3,
        label: '+3 more incidents',
        expiresAt: Math.ceil((now + 10_000) / 1_000) * 1_000,
    });
    director.dispose();
});

test('overflow summary uses compact mixed-scene wording and expires', () => {
    const director = new VillageDirector({ buildings: new Map() });
    const now = Date.now();
    for (let index = 0; index < 8; index++) director._addScene(scene(index, now, 'lifecycle'));
    director._addScene(scene(8, now));

    assert.equal(director.update(null, 16, now).sceneOverflow?.label, '+1 more moment');
    assert.equal(director.update(null, 16, now + 11_000).sceneOverflow, null);
    director.dispose();
});

test('overflow plaque is static under reduced motion', () => {
    const viewport = { width: 1280, height: 720 };
    const base = {
        replayActive: false,
        sceneOverflow: { count: 4, label: '+4 more incidents' },
    };
    const animated = fakeContext();
    const reduced = fakeContext();

    drawVillageDirectorScreen(animated, { ...base, motionScale: 1 }, viewport);
    drawVillageDirectorScreen(reduced, { ...base, motionScale: 0 }, viewport);

    assert.deepEqual(reduced.calls, animated.calls);
    assert.ok(animated.calls.some(call => call[0] === 'fillText' && call[1] === '+4 MORE INCIDENTS'));
});
