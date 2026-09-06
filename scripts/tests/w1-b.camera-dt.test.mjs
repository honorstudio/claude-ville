import assert from 'node:assert/strict';
import test from 'node:test';

import { Camera } from '../../claudeville/src/presentation/character-mode/Camera.js';
import { REF_DT_MS, dtAlpha } from '../../claudeville/src/presentation/character-mode/MotionClock.js';

const TARGET_X = 100;
const TARGET_Y = 80;

function createFollowCamera({ x = 0, y = 0 } = {}) {
    // Camera's module imports are pure. Avoid its browser-only constructor while
    // exercising the real updateFollow implementation without a DOM or canvas.
    const camera = Object.create(Camera.prototype);
    camera.x = x;
    camera.y = y;
    camera.zoom = 1;
    camera.followTarget = {};
    camera.followSmoothing = 0.08;
    camera._reducedMotion = false;
    camera._followEase = null;
    camera._viewportWidth = () => TARGET_X * 2;
    camera._viewportHeight = () => TARGET_Y * 2;
    camera._followFocusPoint = () => ({ x: 0, y: 0 });
    camera._clampToBounds = () => {};
    return camera;
}

function simulateFollow(dtMs) {
    const camera = createFollowCamera();
    const steps = Math.round(1000 / dtMs);
    for (let index = 0; index < steps; index++) camera.updateFollow(dtMs);
    return { x: camera.x, y: camera.y };
}

test('Camera follow converges to the same position at 30, 60, and 120 Hz', () => {
    const at30 = simulateFollow(1000 / 30);
    const at60 = simulateFollow(1000 / 60);
    const at120 = simulateFollow(1000 / 120);

    assert.ok(Math.abs(at30.x - at60.x) < 0.5);
    assert.ok(Math.abs(at30.y - at60.y) < 0.5);
    assert.ok(Math.abs(at120.x - at60.x) < 0.5);
    assert.ok(Math.abs(at120.y - at60.y) < 0.5);
});

test('Camera follow preserves the legacy step at the reference frame duration', () => {
    const camera = createFollowCamera({ x: 25, y: -10 });
    const expectedX = camera.x + (TARGET_X - camera.x) * camera.followSmoothing;
    const expectedY = camera.y + (TARGET_Y - camera.y) * camera.followSmoothing;

    camera.updateFollow(REF_DT_MS);

    assert.ok(Math.abs(camera.x - expectedX) < 1e-12);
    assert.ok(Math.abs(camera.y - expectedY) < 1e-12);
});

test('Camera follow does not overshoot after a 5000 ms stall', () => {
    const camera = createFollowCamera();
    const alpha = dtAlpha(camera.followSmoothing, 5000);

    camera.updateFollow(5000);

    assert.ok(alpha <= 1);
    assert.ok(camera.x >= 0 && camera.x <= TARGET_X);
    assert.ok(camera.y >= 0 && camera.y <= TARGET_Y);
});
