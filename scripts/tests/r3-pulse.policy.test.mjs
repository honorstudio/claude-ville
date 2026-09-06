import assert from 'node:assert/strict';
import test from 'node:test';

import {
    pulseBand01Frame,
    pulseValue,
    pulseValueMs,
} from '../../claudeville/src/presentation/character-mode/PulsePolicy.js';

test('frame-domain normalized pulse preserves the legacy working cadence', () => {
    for (const frame of [0, 1, 17.5, 84, 240]) {
        const legacy = (Math.sin(frame * 0.075) + 1) / 2;
        const migrated = pulseBand01Frame('working', frame, 1, -0.7);
        assert.ok(Math.abs(migrated - legacy) < 1e-12);
    }
});

test('all pulse entry points collapse to fixed reduced-motion values', () => {
    assert.equal(pulseValue('working', 0, 0), pulseValue('working', 9999, 0));
    assert.equal(pulseValueMs('working', 0, 0), pulseValueMs('working', 999999, 0));
    assert.equal(pulseBand01Frame('working', 0, 0), 0.5);
    assert.equal(pulseBand01Frame('working', 9999, 0, 12), 0.5);
});

test('unknown bands retain the intrinsic fallback contract', () => {
    assert.equal(
        pulseBand01Frame('not-a-band', 42, 1, 0.3),
        pulseBand01Frame('intrinsic', 42, 1, 0.3),
    );
});
