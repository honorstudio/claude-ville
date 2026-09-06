import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_MATERIAL_CLASSES,
  buildStableGpuBatches,
  clampGpuLights,
  estimateGpuWorldTextureBytes,
  isAttentionLight,
  localLightPhaseForLighting,
  materialClassId,
  nightMoonCourse,
  resolveGpuWorldRendererMode,
  worldPhaseGrade,
  WORLD_PHASE_GRADES,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import {
  buildGpuWorldRecords,
  gpuMaterialNameForBuilding,
  gpuMaterialNameForProp,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';

test('GPU renderer is the default after parity gates pass with a Canvas escape hatch', () => {
  assert.equal(resolveGpuWorldRendererMode('', { webgl2: true }), 'webgl');
  assert.equal(resolveGpuWorldRendererMode('?renderer=canvas', { webgl2: true }), 'canvas');
  assert.equal(resolveGpuWorldRendererMode('?renderer=webgl', { webgl2: false }), 'canvas');
});

test('stable GPU batches merge only consecutive compatible records', () => {
  const imageA = { width: 16, height: 16 };
  const imageB = { width: 16, height: 16 };
  const records = [
    { source: imageA, textureKey: 'a', x: 0, y: 0, width: 16, height: 16 },
    { source: imageA, textureKey: 'a', x: 16, y: 0, width: 16, height: 16 },
    { source: imageB, textureKey: 'b', x: 32, y: 0, width: 16, height: 16 },
    { source: imageA, textureKey: 'a', x: 48, y: 0, width: 16, height: 16 },
  ];
  const batches = buildStableGpuBatches(records);
  assert.deepEqual(batches.map(batch => batch.records.length), [2, 1, 1]);
  assert.deepEqual(batches.flatMap(batch => batch.records.map(record => record.x)), [0, 16, 32, 48]);
});

test('material ids and light admission are deterministic', () => {
  assert.equal(materialClassId('water'), GPU_MATERIAL_CLASSES.water);
  assert.equal(materialClassId('unknown'), GPU_MATERIAL_CLASSES.default);
  const admitted = clampGpuLights([
    { id: 'b', x: 1, y: 1, priority: 1, intensity: 2 },
    { id: 'a', x: 1, y: 1, priority: 2, intensity: 1 },
    { id: 'invalid', x: Number.NaN, y: 1, priority: 99 },
  ], 1);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].id, 'a');
});

test('the moon selects one reviewed night course and never relights the day', () => {
  assert.equal(nightMoonCourse(0), 'night-new-moon');
  assert.equal(nightMoonCourse(0.3), 'night');
  assert.equal(nightMoonCourse(0.9), 'night-moonlit');
  const dark = worldPhaseGrade('night', 0);
  const shipped = worldPhaseGrade('night', 0.3);
  const moonlit = worldPhaseGrade('night', 0.95);
  assert.ok(dark.base[2] < shipped.base[2] && shipped.base[2] < moonlit.base[2]);
  // A dark night still has to be readable ground, not a black screen.
  assert.ok(dark.base[0] >= 0.4);
  // Daylight phases ignore the moon entirely.
  assert.equal(worldPhaseGrade('day', 1), WORLD_PHASE_GRADES.day);
  assert.equal(worldPhaseGrade('dusk', 1), WORLD_PHASE_GRADES.dusk);
});

test('action-needed lights are recognised so the exposure budget can skip them', () => {
  assert.equal(isAttentionLight({ id: 'attention:waiting:a1' }), true);
  assert.equal(isAttentionLight({ attention: 'errored' }), true);
  assert.equal(isAttentionLight({ id: 'building.harbor.point.1.2' }), false);
});

test('local point lights disappear at noon and rise with darkness or weather beacons', () => {
  assert.equal(localLightPhaseForLighting({ ambientLight: 1, beaconIntensity: 0 }), 0);
  assert.equal(localLightPhaseForLighting({ ambientLight: 0.65, beaconIntensity: 0.2 }), 0.35);
  assert.equal(localLightPhaseForLighting({ ambientLight: 0.9, beaconIntensity: 0.42 }), 0.42);
  assert.equal(localLightPhaseForLighting({ ambientLight: 0, beaconIntensity: 1 }), 1);
});

test('texture byte estimates include render targets and cached sources', () => {
  const estimate = estimateGpuWorldTextureBytes({
    width: 100,
    height: 80,
    bloomScale: 0.5,
    occlusionScale: 0.25,
    cachedTextures: [{ width: 20, height: 10, copies: 2 }],
  });
  assert.equal(estimate.targets, (8000 + 2000 * 2 + 500) * 4);
  assert.equal(estimate.textures, 20 * 10 * 4 * 2);
  assert.equal(estimate.total, estimate.targets + estimate.textures);
});

test('scene builder preserves terrain-first and painter-order records', () => {
  const terrain = { width: 64, height: 32 };
  const building = { width: 20, height: 30 };
  const renderer = {
    terrainCacheKey: 'summer',
    _getTerrainCache: () => ({ canvas: terrain, bounds: { x: -10, y: -5, w: 64, h: 32 } }),
    assets: {
      assetVersion: 'v1',
      get: id => id === 'building.command' ? building : null,
      getDims: () => ({ w: 20, h: 30 }),
      getAnchor: () => [10, 25],
    },
    buildingRenderer: { _buildingOccupancyInfo: () => ({ state: 'occupied' }) },
    camera: { zoom: 1 },
  };
  const records = buildGpuWorldRecords(renderer, {
    drawables: [{
      kind: 'building',
      payload: {
        kind: 'building',
        building: { type: 'command' },
        entry: { id: 'building.command' },
        wx: 100,
        wy: 80,
      },
    }],
  });
  assert.equal(records.length, 2);
  assert.equal(records[0].id, 'terrain:static');
  assert.equal(records[1].id, 'building.command:building');
  assert.equal(records[1].x, 90);
  assert.equal(records[1].y, 55);
});

test('scene material inference follows semantic sprite identity', () => {
  assert.equal(gpuMaterialNameForBuilding('harbor'), 'timber');
  assert.equal(gpuMaterialNameForBuilding('portal'), 'rune');
  assert.equal(gpuMaterialNameForProp({ id: 'veg.tree.oak.large' }), 'foliage');
  assert.equal(gpuMaterialNameForProp({ id: 'prop.runeBrazier' }), 'fire');
});
