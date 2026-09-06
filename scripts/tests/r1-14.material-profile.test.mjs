import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROVIDER_MATERIAL_CLASS,
  PROVIDER_MATERIAL_PROFILES,
  buildGpuWorldRecords,
  gpuMaterialNameForProvider,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import {
  MATERIAL_CLASS_IDS,
  MATERIAL_CLASS_NAMES,
} from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';

test('provider material profiles use contract classes and a documented safe fallback', () => {
  assert.deepEqual(
    Object.keys(PROVIDER_MATERIAL_PROFILES).sort(),
    ['claude', 'codex', 'deepseek', 'gemini', 'git', 'grok', 'kimi', 'omp', 'opencode', 'zai'],
  );
  for (const profile of Object.values(PROVIDER_MATERIAL_PROFILES)) {
    assert.ok(MATERIAL_CLASS_NAMES.includes(profile.defaultMaterialClass));
  }
  assert.equal(DEFAULT_PROVIDER_MATERIAL_CLASS, 'unlit');
  assert.equal(gpuMaterialNameForProvider(' CODEX '), 'metal');
  assert.equal(gpuMaterialNameForProvider('future-provider'), 'unlit');
  assert.equal(gpuMaterialNameForProvider(null), 'unlit');
});

test('agent records read provider defaults without overriding authored material', () => {
  const source = { width: 16, height: 24 };
  const records = buildGpuWorldRecords({}, {
    drawables: [
      {
        kind: 'agent',
        payload: {
          agent: { id: 'gemini-default', provider: 'gemini' },
          _gpuFrameRecord: { source, width: 16, height: 24 },
        },
      },
      {
        kind: 'agent',
        payload: {
          agent: { id: 'unknown-default', provider: 'future-provider' },
          _gpuFrameRecord: { source, width: 16, height: 24 },
        },
      },
      {
        kind: 'agent',
        payload: {
          agent: { id: 'authored', provider: 'codex' },
          _gpuFrameRecord: { source, width: 16, height: 24, material: MATERIAL_CLASS_IDS.fabric },
        },
      },
    ],
  });

  assert.equal(records[0].material, MATERIAL_CLASS_IDS['glass-rune']);
  assert.equal(records[1].material, MATERIAL_CLASS_IDS.unlit);
  assert.equal(records[2].material, MATERIAL_CLASS_IDS.fabric);
});
