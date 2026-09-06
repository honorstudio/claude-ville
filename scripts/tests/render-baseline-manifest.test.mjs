import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifestUrl = new URL('../world/render-baseline-manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));

test('renderer baseline manifest covers required states, atmospheres, and desktop sizes', () => {
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.reference.outputModes, ['webgl', 'postfx', 'canvas']);
    const scenarios = new Set(manifest.captures.map(capture => capture.scenario));
    for (const scenario of [
        'mixed-tools',
        'dense-24-agents',
        'dense-100-agents',
        'no-agents',
        'one-working-agent',
        'waiting-on-user',
        'selected-behind-building',
        'building-inspection-replay',
        'storm-night-reduced-motion',
    ]) {
        assert.ok(scenarios.has(scenario), `missing ${scenario}`);
    }
    assert.ok(manifest.captures.some(capture => capture.agentOverride?.status === 'errored'), 'missing deterministic errored capture');
    const weather = new Set(manifest.captures.map(capture => capture.atmosphere.weather));
    assert.deepEqual([...weather].sort(), ['clear', 'rain', 'storm']);
    const hours = new Set(manifest.captures.map(capture => capture.atmosphere.hour));
    for (const hour of [12, 15, 19, 23]) assert.ok(hours.has(hour), `missing hour ${hour}`);
    assert.deepEqual(
        manifest.reference.viewports.map(viewport => `${viewport.width}x${viewport.height}`),
        ['1440x900', '1920x1080', '2560x1440'],
    );
    assert.equal(manifest.captures.filter(capture => capture.northStar).length, 3);
    assert.ok(manifest.captures.filter(capture => capture.overlayCensus).length >= 2);
});

test('every capture declares a reproducible camera and focal subject', () => {
    const ids = new Set();
    for (const capture of manifest.captures) {
        assert.ok(capture.id && !ids.has(capture.id));
        ids.add(capture.id);
        assert.ok(['absolute', 'scenario-metadata'].includes(capture.camera.mode));
        assert.ok(Number.isFinite(capture.camera.zoom));
        assert.ok(capture.expected?.focalSubject);
    }
});
