import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCE_ENERGY_BUCKETS,
  createAtmosphereSnapshot,
  moonFillFor,
  normalizeLightingState,
  sourceEnergyEnvelope,
  sourceEnergyFor,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';

const CLEAR = { type: 'clear', intensity: 0, cloudCover: 0 };

function envelopeAtHour(hour, weather = 'clear') {
  const snapshot = createAtmosphereSnapshot({
    now: new Date(2026, 8, 6, 12, 0, 0),
    hourOverride: hour,
    weatherOverride: weather,
  });
  return { snapshot, energy: snapshot.lighting.sourceEnergy };
}

test('every reviewed exposure bucket spends cores before broad bloom', () => {
  for (const bucket of Object.values(SOURCE_ENERGY_BUCKETS)) {
    assert.ok(
      bucket.core > bucket.bloom,
      `${bucket.bucket}: core ${bucket.core} must outrank bloom ${bucket.bloom}`,
    );
    assert.ok(bucket.halo <= 1, `${bucket.bucket}: halo area may not exceed authored geometry`);
  }
});

test('dusk into night walks up the reviewed buckets, cores first and bloom last', () => {
  const hours = [17, 19, 21, 23];
  const seen = hours.map(hour => envelopeAtHour(hour).energy);
  assert.deepEqual(seen.map(energy => energy.bucket), ['daylight', 'settling', 'lamplight', 'deep-night']);
  for (let index = 1; index < seen.length; index++) {
    assert.ok(seen[index].core >= seen[index - 1].core, 'core energy never falls as the sky cools');
    assert.ok(seen[index].bloom >= seen[index - 1].bloom, 'bloom follows, never leads');
    // Bloom's share of the same envelope stays the smallest of the three.
    assert.ok(seen[index].bloom < seen[index].core);
    assert.ok(seen[index].bloom < seen[index].spill);
  }
});

test('a hundred agents cannot raise the envelope, but heavy weather steps it once', () => {
  const clearDusk = sourceEnergyEnvelope('dusk', 0.6, CLEAR);
  const stormyDusk = sourceEnergyEnvelope('dusk', 0.6, { type: 'storm', intensity: 0.9 });
  assert.equal(clearDusk.bucket, 'settling');
  assert.equal(stormyDusk.bucket, 'lamplight');
  // One step only: a storm never overshoots the deepest night bucket by day.
  assert.equal(sourceEnergyEnvelope('day', 0.5, { type: 'storm', intensity: 1 }).bucket, 'settling');
  // Night is already at the ceiling and weather cannot push it further.
  assert.equal(sourceEnergyEnvelope('night', 0.6, { type: 'storm', intensity: 1 }).bucket, 'deep-night');
});

test('a feed authored without an envelope keeps today response', () => {
  const neutral = sourceEnergyFor({ ambientLight: 0.2 });
  assert.equal(neutral.core, 1);
  assert.equal(neutral.spill, 1);
  assert.equal(neutral.bloom, 1);
  assert.equal(normalizeLightingState({}).sourceEnergy.core, 1);
  assert.equal(normalizeLightingState({ sourceEnergy: SOURCE_ENERGY_BUCKETS.lamplight }).sourceEnergy.core, 0.9);
});

test('moon fill is night-only and follows real illumination and cloud cover', () => {
  const brightMoon = { visible: true, alpha: 0.8, phase: { illumination: 1 } };
  assert.equal(moonFillFor('day', brightMoon, CLEAR), 0);
  assert.equal(moonFillFor('dusk', brightMoon, CLEAR), 0);
  assert.ok(moonFillFor('night', brightMoon, CLEAR) > 0.5);
  assert.ok(
    moonFillFor('night', brightMoon, { type: 'storm', intensity: 1, cloudCover: 1 })
    < moonFillFor('night', brightMoon, CLEAR),
    'cloud cover cuts the fill',
  );
  assert.equal(moonFillFor('night', { visible: false, alpha: 0, phase: { illumination: 1 } }, CLEAR), 0);
  assert.ok(moonFillFor('night', { visible: true, alpha: 0.4, phase: { illumination: 0.02 } }, CLEAR) < 0.02);
});

test('the night grade course is part of the atmosphere cache key', () => {
  // 2026-09-11 is a new moon and 2026-09-25 a full moon in this lunar model.
  const newMoon = createAtmosphereSnapshot({ now: new Date(2026, 8, 11, 1, 0, 0) });
  const fullMoon = createAtmosphereSnapshot({ now: new Date(2026, 8, 25, 1, 0, 0) });
  assert.equal(newMoon.phase, 'night');
  assert.equal(fullMoon.phase, 'night');
  assert.ok(fullMoon.lighting.moonFill > newMoon.lighting.moonFill);
  assert.notEqual(newMoon.cacheKey, fullMoon.cacheKey);
});
