import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AUDIO_MIXER_DEFAULTS,
    AmbientAudioController,
    readStoredLayerLevels,
} from '../../claudeville/src/presentation/shared/AmbientAudioController.js';
import { TopBar } from '../../claudeville/src/presentation/shared/TopBar.js';

function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
    };
}

function mixerHarness(storage = memoryStorage()) {
    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        layerLevels: readStoredLayerLevels(storage),
        layerControls: {},
        _layerBindings: new WeakMap(),
        directors: {
            ambient: { running: false, layers: {} },
            bgm: { running: false, player: null },
        },
    });
    return controller;
}

test('stored mixer levels are complete, clamped, and tolerate corrupt data', () => {
    const stored = memoryStorage({
        'claudeville.sound.layers': JSON.stringify({
            wind: 0.25,
            rain: 4,
            wildlife: -2,
            hum: '0.4',
        }),
    });
    assert.deepEqual(readStoredLayerLevels(stored), {
        wind: 0.25,
        rain: 1,
        wildlife: 0,
        hum: 0.4,
        music: 1,
    });
    assert.deepEqual(
        readStoredLayerLevels(memoryStorage({ 'claudeville.sound.layers': '{oops' })),
        { ...AUDIO_MIXER_DEFAULTS },
    );
});

test('layer trims persist and scale changing live targets instead of pinning them', () => {
    const previousWindow = globalThis.window;
    const storage = memoryStorage();
    globalThis.window = { localStorage: storage };
    try {
        const controller = mixerHarness(storage);
        const calls = [];
        const wind = {
            level: 0.8,
            setLevel(value, slew) {
                this.level = value;
                calls.push({ value, slew });
            },
        };
        controller.directors.ambient.layers.wind = wind;
        controller._bindLayerMix(wind, 'wind');
        assert.equal(calls.at(-1).value, 0.8);

        assert.equal(controller.setLayerLevel('wind', 0.25), true);
        assert.equal(calls.at(-1).value, 0.2);
        assert.equal(JSON.parse(storage.getItem('claudeville.sound.layers')).wind, 0.25);
        assert.equal(mixerHarness(storage).layerLevels.wind, 0.25);

        wind.setLevel(0.6, 4);
        assert.deepEqual(calls.at(-1), { value: 0.15, slew: 4 });
        assert.equal(controller.setLayerLevel('unknown', 0), false);
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

test('five controls cover both wildlife voices, tonal music, and BGM', () => {
    const controller = mixerHarness();
    controller.layerLevels = { wind: 0.5, rain: 0.4, wildlife: 0.3, hum: 0.2, music: 0.1 };
    const layer = level => ({ level, setLevel(value) { this.level = value; } });
    const layers = {
        wind: layer(0.8), rain: layer(1), birds: layer(0.6), crickets: layer(0.7),
        hum: layer(0.5), bed: layer(0.4), music: layer(0.9),
    };
    const player = layer(0.9);
    controller.directors = {
        ambient: { running: true, layers },
        bgm: { running: true, player },
    };
    controller._installActiveLayerMix();

    assert.equal(layers.wind.level, 0.4);
    assert.equal(layers.rain.level, 0.4);
    assert.equal(layers.birds.level, 0.18);
    assert.ok(Math.abs(layers.crickets.level - 0.21) < 1e-12);
    assert.equal(layers.hum.level, 0.1);
    assert.ok(Math.abs(layers.bed.level - 0.04) < 1e-12);
    assert.ok(Math.abs(layers.music.level - 0.09) < 1e-12);
    assert.ok(Math.abs(player.level - 0.09) < 1e-12);
});

test('hidden-tab summons still wakes audio for the cue and schedules suspension', async () => {
    const events = [];
    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        _visibilityGeneration: 7,
        _hiddenSummonsPending: new Set(),
        _suspendTimer: null,
        enabled: true,
        available: true,
        userActivated: true,
        engine: {
            ensureContext: async () => true,
            start: () => events.push('engine:start'),
        },
        directors: {
            ambient: { playSummons: payload => events.push(`summons:${payload.agentId}`) },
        },
        _scheduleHiddenSummonsSuspend: generation => events.push(`suspend:${generation}`),
    });

    controller._handleHiddenSummons({ agentId: 'agent-hidden' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['engine:start', 'summons:agent-hidden', 'suspend:7']);
    assert.equal(controller._hiddenSummonsPending.size, 0);
});

test('mixer and Spend Map explicitly close one another before opening', () => {
    const classNames = new Set();
    const mixer = {
        style: { display: 'none' },
    };
    const button = {
        getBoundingClientRect: () => ({ right: 1240, bottom: 48 }),
        setAttribute() {},
        classList: {
            add: name => classNames.add(name),
            remove: name => classNames.delete(name),
        },
    };
    let spendClosed = 0;
    const previousWindow = globalThis.window;
    globalThis.window = { innerWidth: 1280 };
    try {
        TopBar.prototype._showMixerPanel.call({
            _destroyed: false,
            _mixerButtonEl: button,
            _mixerPanelEl: mixer,
            _hideSpendPanel: () => { spendClosed++; },
        });
        assert.equal(spendClosed, 1);
        assert.equal(mixer.style.display, 'block');

        let mixerClosed = 0;
        const spendPanel = { style: { display: 'none' } };
        TopBar.prototype._showSpendPanel.call({
            _destroyed: false,
            els: {
                rateWrap: {
                    getBoundingClientRect: () => ({ left: 300, bottom: 48 }),
                    setAttribute() {},
                },
            },
            _hideMixerPanel: () => { mixerClosed++; },
            _ensureSpendPanel() {},
            _renderSpendPanel() {},
            _spendPanelEl: spendPanel,
        });
        assert.equal(mixerClosed, 1);
        assert.equal(spendPanel.style.display, 'block');
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
