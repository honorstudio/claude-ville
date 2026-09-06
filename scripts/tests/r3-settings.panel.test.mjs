import test from 'node:test';
import assert from 'node:assert/strict';
import { installReducedMotionOverride } from '../../claudeville/src/presentation/shared/SettingsPanel.js';

import {
    PERSISTED_SETTING_DEFAULTS,
    TopBar,
    readPersistedSettings,
    resetPersistedSettings,
} from '../../claudeville/src/presentation/shared/TopBar.js';

class MemoryStorage {
    constructor(entries = {}) {
        this.values = new Map(Object.entries(entries));
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }
}

test('reduced-motion reads reuse one native query and preserve override notifications', () => {
    let queryCount = 0;
    let nativeListenerCount = 0;
    let legacyListenerCount = 0;
    let notifyNative;
    const native = {
        media: '(prefers-reduced-motion: reduce)', matches: false,
        addEventListener(type, listener) {
            assert.equal(type, 'change');
            nativeListenerCount++;
            notifyNative = listener;
        },
        addListener() { legacyListenerCount++; },
    };
    const unrelated = { media: '(min-width: 1280px)', matches: true };
    const root = {
        localStorage: new MemoryStorage(),
        document: { documentElement: { classList: { toggle() {} } } },
        matchMedia(query) { queryCount++; return query === native.media ? native : unrelated; },
    };
    const controller = installReducedMotionOverride(root);
    for (let index = 0; index < 100; index++) assert.equal(root.matchMedia(native.media).matches, false);
    assert.equal(queryCount, 1);
    assert.equal(nativeListenerCount, 1);
    assert.equal(legacyListenerCount, 0);
    const query = root.matchMedia(native.media);
    const changes = [];
    const listener = event => changes.push(event.matches);
    query.addEventListener('change', listener);
    controller.set(true);
    controller.set(true);
    native.matches = true;
    notifyNative();
    controller.set(false);
    assert.equal(query.matches, true, 'native preference remains effective when override is off');
    native.matches = false;
    notifyNative();
    assert.deepEqual(changes, [true, false]);
    query.removeEventListener('change', listener);
    controller.set(true);
    assert.deepEqual(changes, [true, false], 'removed observers are released');
    assert.equal(root.matchMedia(unrelated.media), unrelated, 'other queries retain native behavior');
    assert.equal(queryCount, 2);
});

test('settings review reads every operator preference using its existing encoding', () => {
    const storage = new MemoryStorage({
        'claudeville.sound.enabled': 'true',
        'claudeville.sound.volume': '0.72',
        'claudeville.sound.mode': 'bgm',
        'claudeville.sound.layers': JSON.stringify({
            wind: 0.1, rain: 0.2, wildlife: 0.3, hum: 0.4, music: 0.5,
        }),
        'cv-auto-camera': '0',
        'claudeville.alerts.desktop': '1',
        'claudeville.sidebarCollapsed': 'true',
    });

    assert.deepEqual(readPersistedSettings(storage), {
        soundEnabled: true,
        soundVolume: 0.72,
        soundMode: 'bgm',
        soundLayers: { wind: 0.1, rain: 0.2, wildlife: 0.3, hum: 0.4, music: 0.5 },
        autoCamera: false,
        desktopAlerts: true,
        sidebarCollapsed: true,
    });
});

test('settings defaults retain all established localStorage keys and value formats', () => {
    assert.deepEqual(PERSISTED_SETTING_DEFAULTS, {
        'claudeville.sound.enabled': 'false',
        'claudeville.sound.volume': '0.5',
        'claudeville.sound.mode': 'ambient',
        'claudeville.sound.layers': JSON.stringify({
            wind: 1, rain: 1, wildlife: 1, hum: 1, music: 1,
        }),
        'cv-auto-camera': '1',
        'claudeville.alerts.desktop': '0',
        'claudeville.sidebarCollapsed': 'false',
    });
});

test('reset writes defaults in place without clearing unrelated local data', () => {
    const storage = new MemoryStorage({
        ...Object.fromEntries(Object.keys(PERSISTED_SETTING_DEFAULTS).map(key => [key, 'changed'])),
        'claudeville.generatedNames': '["Ada"]',
    });

    const result = resetPersistedSettings(storage);

    for (const [key, value] of Object.entries(PERSISTED_SETTING_DEFAULTS)) {
        assert.equal(storage.getItem(key), value, key);
    }
    assert.equal(storage.getItem('claudeville.generatedNames'), '["Ada"]');
    assert.equal(result.soundEnabled, false);
    assert.equal(result.soundVolume, 0.5);
    assert.equal(result.autoCamera, true);
});

test('opening settings first dismisses both topbar popovers', () => {
    const calls = [];
    const topbar = Object.create(TopBar.prototype);
    topbar._destroyed = false;
    topbar._hideMixerPanel = () => calls.push('mix');
    topbar._hideSpendPanel = () => calls.push('spend');
    topbar._buildSettingsContent = () => ({ node: true });
    topbar.modal = {
        openContent(title, content, options) {
            calls.push(['modal', title, content, options]);
        },
    };

    topbar._openSettings();

    assert.equal(calls[0], 'mix');
    assert.equal(calls[1], 'spend');
    assert.deepEqual(calls[2], [
        'modal',
        'Settings',
        { node: true },
        { wide: true, owner: 'topbar-settings' },
    ]);
});

test('Spend Map and MIX close settings before either popover becomes visible', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { innerWidth: 1280 };
    try {
        const mixerCalls = [];
        const mixer = Object.create(TopBar.prototype);
        mixer._destroyed = false;
        mixer._closeSettings = () => mixerCalls.push('settings');
        mixer._hideSpendPanel = () => mixerCalls.push('spend');
        mixer._mixerButtonEl = {
            getBoundingClientRect: () => ({ right: 1000, bottom: 40 }),
            setAttribute: () => {},
            classList: { add: () => {} },
        };
        mixer._mixerPanelEl = { style: { display: 'none' } };
        mixer._showMixerPanel();
        assert.deepEqual(mixerCalls, ['settings', 'spend']);
        assert.equal(mixer._mixerPanelEl.style.display, 'block');

        const spendCalls = [];
        const spend = Object.create(TopBar.prototype);
        spend._destroyed = false;
        spend._closeSettings = () => spendCalls.push('settings');
        spend._hideMixerPanel = () => spendCalls.push('mix');
        spend._ensureSpendPanel = () => {};
        spend._renderSpendPanel = () => {};
        spend._spendPanelEl = { style: { display: 'none' } };
        spend.els = {
            rateWrap: {
                getBoundingClientRect: () => ({ left: 300, bottom: 40 }),
                setAttribute: () => {},
            },
        };
        spend._showSpendPanel();
        assert.deepEqual(spendCalls, ['settings', 'mix']);
        assert.equal(spend._spendPanelEl.style.display, 'block');
    } finally {
        globalThis.window = previousWindow;
    }
});
