import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    RESOURCE_OWNERSHIP,
    gpuResourceAccounting,
    shouldEvictAtHighWater,
    sumUniqueResourceEstimates,
    unifiedRendererResourceAccounting,
    unpinnedCacheKeys,
} from '../../claudeville/src/presentation/character-mode/CanvasBudget.js';

test('a shared cache referenced by three sprites is counted once', () => {
    const references = [1, 2, 3].map(() => ({
        key: 'equipped-sheet:shared-profile',
        estimateBytes: 4096,
        ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
    }));
    assert.equal(sumUniqueResourceEstimates(references), 4096);
});

test('CPU backing estimates and GL texture bytes remain separate leaves', () => {
    const resources = unifiedRendererResourceAccounting({
        cpuDerivedEstimates: [{ key: 'agent-sheet', estimateBytes: 4096 }],
        gpuOwnedEstimates: [{ key: 'agent-sheet', estimateBytes: 4096 }],
    });
    assert.equal(resources.ownershipLeaves.cpuDerivedEstimateBytes, 4096);
    assert.equal(resources.ownershipLeaves.gpuOwnedBytes, 4096);
    assert.equal(resources.totalBytes, 8192);
});

test('pinned entries are never selected for eviction', () => {
    const entries = [
        { key: 'pinned', estimateBytes: 80 },
        { key: 'reloadable', estimateBytes: 40 },
    ];
    assert.equal(shouldEvictAtHighWater(120, 100), true);
    assert.deepEqual(unpinnedCacheKeys(entries, new Set(['pinned'])), ['reloadable']);
});

test('an unpinned entry is evictable and reloadable on demand', () => {
    const cache = new Map([['profile', { pixels: 10 }]]);
    const evictable = unpinnedCacheKeys([{ key: 'profile' }], new Set());
    cache.delete(evictable[0]);
    assert.equal(cache.has('profile'), false);
    const reload = () => ({ pixels: 10 });
    cache.set('profile', reload());
    assert.deepEqual(cache.get('profile'), { pixels: 10 });
});

test('the unified total equals the sum of its named ownership leaves', () => {
    const resources = unifiedRendererResourceAccounting({
        visibleCanvasPixels: 10,
        volatileCanvasPixels: 20,
        retainedCanvasPixels: 30,
        cpuDecodedEstimates: [{ key: 'decoded', estimateBytes: 50 }],
        gpu: gpuResourceAccounting({ textures: { atlas: 70 } }),
    });
    assert.equal(
        resources.totalBytes,
        Object.values(resources.ownershipLeaves).reduce((sum, bytes) => sum + bytes, 0),
    );
});

test('sharedCacheStats reports the GPU-equipped sheet cache', async () => {
    const sourceUrl = new URL(
        '../../claudeville/src/presentation/character-mode/AgentSprite.js',
        import.meta.url,
    );
    const source = await readFile(sourceUrl, 'utf8');
    const statsStart = source.indexOf('static sharedCacheStats()');
    const statsEnd = source.indexOf('static evictUnpinnedSharedCaches', statsStart);
    const statsSource = source.slice(statsStart, statsEnd);
    assert.match(statsSource, /GPU_EQUIPPED_SHEET_CACHE/);
    assert.match(statsSource, /gpuEquippedSheetEstimateBytes/);
    assert.match(statsSource, /gpuAgentMaterialAtlasEstimateBytes/);
    assert.match(statsSource, /gpuAgentEmissiveAtlasEstimateBytes/);
});

test('DOM-coupled cache modules remain importable without browser stubs', async () => {
    const [assetsModule, spritesModule] = await Promise.all([
        import('../../claudeville/src/presentation/character-mode/AssetManager.js'),
        import('../../claudeville/src/presentation/character-mode/AgentSprite.js'),
    ]);
    assert.equal(typeof assetsModule.AssetManager, 'function');
    assert.equal(typeof spritesModule.AgentSprite, 'function');
    const manager = new assetsModule.AssetManager();
    const stats = manager.cacheStats();
    assert.deepEqual(Object.keys(stats), [
        'bitmaps',
        'bitmapPixels',
        'masks',
        'maskBytes',
        'outlines',
        'outlinePixels',
        'companions',
        'companionPixels',
        'atlasImages',
        'atlasPixels',
        'atlasMetadata',
        'materialTextureBytes',
        'missing',
        'optionalMissing',
        'decodedLoaded',
        'materialAssetsEnabled',
        'materialDecodedLoaded',
        'suspended',
        'loadInFlight',
        'decodePasses',
    ]);
    assert.equal(stats.decodedImageEstimateBytes, 0);
    assert.equal(stats.derivedCanvasEstimateBytes, 0);
    manager.retainProfileAssets('active-profile', ['agent.test.base'], { selected: true });
    manager.bitmaps.set('agent.test.base', { width: 8, height: 8 });
    manager.alphaMasks.set('agent.test.base', new Uint8Array(64));
    manager.outlines.set('agent.test.base', { width: 8, height: 8 });
    manager.suspend();
    const suspended = manager.cacheStats();
    assert.equal(suspended.decodedImageEstimateBytes, 0);
    assert.equal(suspended.derivedCanvasEstimateBytes, 0);
    assert.deepEqual(suspended.activeProfileKeys, []);
    manager.dispose();
});
