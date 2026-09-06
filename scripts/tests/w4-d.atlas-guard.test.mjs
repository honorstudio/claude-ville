import test from 'node:test';
import assert from 'node:assert/strict';

import { MATERIAL_CHANNELS } from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    channelsForManifest,
    companionChannels,
} from '../sprites/channel-registry.mjs';
import { packFrames } from '../sprites/atlas-packing.mjs';

test('atlas packing fails loudly when the power-of-two page exceeds max height', () => {
    assert.throws(
        () => packFrames([
            { key: 'fixture.first', w: 30, h: 30 },
            { key: 'fixture.second', w: 30, h: 30 },
        ], { maxWidth: 32, maxHeight: 32, padding: 1, powerOfTwo: true }),
        (error) => {
            assert.match(error.message, /atlas page height budget exceeded/);
            assert.match(error.message, /64px required/);
            assert.match(error.message, /maximum is 32px/);
            assert.match(error.message, /32px over/);
            assert.match(error.message, /last packed frame: fixture\.second/);
            assert.match(error.message, /reduce atlas ids\/frames or raise maxHeight/);
            return true;
        },
    );
});

test('a page at the explicit height budget remains valid', () => {
    const layout = packFrames([
        { key: 'fixture.only', w: 30, h: 30 },
    ], { maxWidth: 32, maxHeight: 32, padding: 1, powerOfTwo: true });
    assert.equal(layout.width, 32);
    assert.equal(layout.height, 32);
});

test('channel enumeration follows the manifest contract and derives companions', () => {
    const futureChannels = [...MATERIAL_CHANNELS, 'normal'];
    const manifest = { materialContract: { channels: futureChannels } };
    assert.deepEqual(channelsForManifest(manifest), futureChannels);
    assert.deepEqual(companionChannels(futureChannels), futureChannels.slice(1));
});
