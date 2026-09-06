import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeLightSource } from '../../claudeville/src/presentation/character-mode/LightSourceRegistry.js';
import { clampGpuLights } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { packGpuSidecarPixels } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';

test('occluder height and strength survive the packed material map independently', () => {
    const packed = packGpuSidecarPixels({
        material: new Uint8ClampedArray([3, 0, 0, 255, 4, 0, 0, 255]),
        emissive: new Uint8ClampedArray([12, 34, 56, 64, 90, 80, 70, 128]),
        occluder: new Uint8ClampedArray([19, 203, 77, 255, 231, 17, 42, 0]),
        pixelCount: 2,
    });

    assert.deepEqual([...packed.packed], [3, 64, 19, 203, 4, 128, 231, 17]);
    assert.deepEqual([...packed.emissive], [12, 34, 56, 64, 90, 80, 70, 128]);
});

test('occlusion keeps the existing three samples while tracing authored height and strength', async () => {
    const source = await readFile(new URL(
        '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js',
        import.meta.url,
    ), 'utf8');

    assert.match(source, /for \(int stepIndex = 1; stepIndex <= 3; stepIndex\+\+\)/);
    assert.match(source, /vec4 occluder = texture\(u_occlusion/);
    assert.match(source, /float rayHeight = mix\(elevation, 0\.0, t\)/);
    assert.match(source, /blocked = max\(blocked, heightBlock \* occluder\.a\)/);
    assert.equal((source.match(/texture\(u_occlusion/g) || []).length, 1);
});

test('authored light priority survives normalization and controls the admitted slot', () => {
    const incidental = normalizeLightSource({
        id: 'lantern',
        x: 80,
        y: 80,
        priority: 1,
        intensity: 3,
    });
    const lighthouse = normalizeLightSource({
        id: 'lighthouse',
        x: 120,
        y: 80,
        priority: 9,
        intensity: 1,
    });

    assert.equal(incidental.priority, 1);
    assert.equal(lighthouse.priority, 9);
    assert.equal(clampGpuLights([incidental, lighthouse], 1)[0].id, 'lighthouse');
});
