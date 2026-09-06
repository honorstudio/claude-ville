import { snapshotAgeMs, linkStatusText } from '../../application/VillageState.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { el, replaceChildren } from './DomSafe.js';
import { getClientPerfMetrics } from './ClientPerfMetrics.js';

export const REDUCED_MOTION_OVERRIDE_KEY = 'claudeville.motion.reduce';
const HOOK_LIVE_WINDOW_MS = 15_000;
const HEALTH_REFRESH_MS = 1_000;
const SOUND_LAYERS = Object.freeze([
    ['wind', 'Wind'],
    ['rain', 'Rain'],
    ['wildlife', 'Wildlife'],
    ['hum', 'Village hum'],
    ['music', 'Music'],
]);

let motionOverrideController = null;

function storageGet(storage, key) {
    try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function storageSet(storage, key, value) {
    try { storage?.setItem(key, value); } catch { /* persistence is optional */ }
}

export function readReducedMotionOverride(storage = globalThis.window?.localStorage) {
    return storageGet(storage, REDUCED_MOTION_OVERRIDE_KEY) === '1';
}

function callMediaListener(listener, event) {
    if (typeof listener === 'function') listener(event);
    else listener?.handleEvent?.(event);
}

/**
 * Make the operator override look like the native reduced-motion query to
 * renderers created after TopBar, while leaving every other media query alone.
 */
export function installReducedMotionOverride(root = globalThis.window) {
    if (motionOverrideController || !root?.matchMedia) return motionOverrideController;
    const nativeMatchMedia = root.matchMedia.bind(root);
    let reducedMotionRecord = null;
    let forced = readReducedMotionOverride(root.localStorage);

    const applyClass = () => {
        root.document?.documentElement?.classList.toggle('cv-reduced-motion-override', forced);
    };
    const effectiveMatches = (nativeQuery) => forced || nativeQuery.matches;
    const notify = (record) => {
        const next = effectiveMatches(record.nativeQuery);
        if (next === record.lastMatches) return;
        record.lastMatches = next;
        const event = { type: 'change', media: record.media, matches: next };
        for (const listener of record.listeners) callMediaListener(listener, event);
        callMediaListener(record.proxy.onchange, event);
    };

    root.matchMedia = (query) => {
        if (String(query).trim() !== '(prefers-reduced-motion: reduce)') return nativeMatchMedia(query);
        // Every caller observes the same preference. In particular, creating
        // an AgentSprite only reads .matches and must not retain a new query.
        if (reducedMotionRecord) return reducedMotionRecord.proxy;
        const nativeQuery = nativeMatchMedia(query);
        const record = {
            media: nativeQuery.media,
            nativeQuery,
            listeners: new Set(),
            lastMatches: effectiveMatches(nativeQuery),
            proxy: null,
        };
        const onNativeChange = () => notify(record);
        const proxy = {
            media: nativeQuery.media,
            onchange: null,
            get matches() { return effectiveMatches(nativeQuery); },
            addEventListener(type, listener) {
                if (type === 'change' && listener) record.listeners.add(listener);
            },
            removeEventListener(type, listener) {
                if (type === 'change') record.listeners.delete(listener);
            },
            addListener(listener) { if (listener) record.listeners.add(listener); },
            removeListener(listener) { record.listeners.delete(listener); },
            dispatchEvent(event) {
                for (const listener of record.listeners) callMediaListener(listener, event);
                return true;
            },
        };
        record.proxy = proxy;
        reducedMotionRecord = record;
        if (nativeQuery.addEventListener) nativeQuery.addEventListener('change', onNativeChange);
        else nativeQuery.addListener?.(onNativeChange);
        return proxy;
    };

    motionOverrideController = {
        get reduced() { return forced; },
        set(reduced) {
            forced = Boolean(reduced);
            storageSet(root.localStorage, REDUCED_MOTION_OVERRIDE_KEY, forced ? '1' : '0');
            applyClass();
            if (reducedMotionRecord) notify(reducedMotionRecord);
            return forced;
        },
    };
    applyClass();
    return motionOverrideController;
}

function oneDecimal(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(1) : null;
}

function ageText(ageMs) {
    const value = Number(ageMs);
    if (!Number.isFinite(value) || value < 0) return 'not received';
    if (value < 10_000) return `${(value / 1000).toFixed(1)} s`;
    return `${Math.round(value / 1000)} s`;
}

function providerState(provider) {
    const sessions = Math.max(0, Number(provider?.sessions) || 0);
    if (provider?.health === 'unavailable') return 'not installed';
    if (provider?.health === 'degraded') return 'degraded';
    if (provider?.health === 'empty' || sessions === 0) return 'empty';
    return `ready · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`;
}

function providerClass(provider) {
    if (provider?.health === 'degraded') return 'settings-provider--degraded';
    if (provider?.health === 'unavailable') return 'settings-provider--unavailable';
    return 'settings-provider--ready';
}

export class SettingsPanel {
    constructor({
        readSettings,
        onSoundEnabled,
        onSoundMode,
        onSoundVolume,
        onSoundLayer,
        onAutoCamera,
        onDesktopAlerts,
        onSidebarCollapsed,
        onReducedMotion,
        onReset,
        getVillageState,
        getChronicleStatus,
        getCurrentFps,
        getHookFreshness,
        unknownModelSeenToday,
        alertsAvailable = true,
        fetchImpl = globalThis.fetch,
    } = {}) {
        this.readSettings = readSettings;
        this.onSoundEnabled = onSoundEnabled;
        this.onSoundMode = onSoundMode;
        this.onSoundVolume = onSoundVolume;
        this.onSoundLayer = onSoundLayer;
        this.onAutoCamera = onAutoCamera;
        this.onDesktopAlerts = onDesktopAlerts;
        this.onSidebarCollapsed = onSidebarCollapsed;
        this.onReducedMotion = onReducedMotion;
        this.onReset = onReset;
        this.getVillageState = getVillageState;
        this.getChronicleStatus = getChronicleStatus;
        this.getCurrentFps = getCurrentFps;
        this.getHookFreshness = getHookFreshness;
        this.unknownModelSeenToday = unknownModelSeenToday;
        this.alertsAvailable = Boolean(alertsAvailable);
        this.fetchImpl = fetchImpl;
        this.root = null;
        this.providers = [];
        this.controls = new Map();
        this._destroyed = false;
        this._providerController = null;
        this._refreshTimer = null;
        this._metricsStartedHere = false;
    }

    build() {
        const settings = this.readSettings?.() || {};
        this.root = el('div', { className: 'settings-panel' });
        this.root.append(
            el('p', {
                className: 'settings-panel__intro',
                text: 'Preferences, local watchtowers, storage, pricing, and live browser health.',
            }),
            this._buildControls(settings),
            this._buildWatchtowers(),
            this._buildStorage(),
            this._buildPricing(),
            this._buildHealth(),
            this._buildActions(),
        );

        const metrics = getClientPerfMetrics();
        this._metricsStartedHere = metrics?.start?.({ reset: false }) === true;
        this._refreshOperationalRows();
        this._refreshTimer = globalThis.setInterval?.(() => {
            if (!this.root?.isConnected) {
                this.destroy();
                return;
            }
            this._refreshOperationalRows();
        }, HEALTH_REFRESH_MS);
        void this._loadProviders();
        return this.root;
    }

    _section(title, className, children = []) {
        return el('section', { className: `settings-section ${className}` }, [
            el('h3', { className: 'settings-section__heading', text: title }),
            ...children,
        ]);
    }

    _buildControls(settings) {
        const grid = el('div', { className: 'settings-controls' });
        grid.append(
            this._checkbox('soundEnabled', 'Sound', 'Enable the local soundscape.', settings.soundEnabled, this.onSoundEnabled),
            this._select('soundMode', 'Sound mode', 'Choose reactive ambience or continuous town music.', [
                ['ambient', 'Reactive ambience'],
                ['bgm', 'Town music'],
            ], settings.soundMode, this.onSoundMode),
            this._range('soundVolume', 'Master volume', settings.soundVolume, this.onSoundVolume),
            this._checkbox('autoCamera', 'Automatic camera', 'Frame live action while the World is idle.', settings.autoCamera, this.onAutoCamera),
            this._checkbox('desktopAlerts', 'Desktop alerts', this.alertsAvailable
                ? 'Notify when an agent needs you.'
                : 'Unavailable in this browser.', settings.desktopAlerts, this.onDesktopAlerts, !this.alertsAvailable),
            this._checkbox('sidebarCollapsed', 'Collapse sidebar', 'Keep the agent roster folded.', settings.sidebarCollapsed, this.onSidebarCollapsed),
            this._checkbox('reducedMotion', 'Reduce motion', 'Override the system preference for this browser.', settings.reducedMotion, this.onReducedMotion),
        );

        const mix = el('fieldset', { className: 'settings-soundscape' }, [
            el('legend', { className: 'settings-soundscape__legend', text: 'SOUNDSCAPE MIX' }),
        ]);
        for (const [name, label] of SOUND_LAYERS) {
            mix.appendChild(this._range(
                `soundLayer:${name}`,
                label,
                settings.soundLayers?.[name],
                (value) => this.onSoundLayer?.(name, value),
                true,
            ));
        }
        grid.appendChild(mix);
        return this._section('CONTROLS', 'settings-section--controls', [grid]);
    }

    _settingRow(label, detail, control) {
        return el('div', { className: 'settings-control' }, [
            el('div', { className: 'settings-control__copy' }, [
                el('span', { className: 'settings-control__label', text: label }),
                detail ? el('span', { className: 'settings-control__detail', text: detail }) : null,
            ]),
            control,
        ]);
    }

    _checkbox(key, label, detail, checked, callback, disabled = false) {
        const input = el('input', { className: 'settings-switch__input', ariaLabel: label });
        input.type = 'checkbox';
        input.checked = Boolean(checked);
        input.disabled = disabled;
        input.addEventListener('change', async () => {
            input.setAttribute('aria-busy', 'true');
            try {
                const result = await callback?.(input.checked);
                if (typeof result === 'boolean') input.checked = result;
            } finally {
                input.removeAttribute('aria-busy');
            }
        });
        this.controls.set(key, input);
        return this._settingRow(label, detail, el('label', { className: 'settings-switch' }, [
            input,
            el('span', { className: 'settings-switch__track', ariaLabel: null }),
        ]));
    }

    _select(key, label, detail, choices, value, callback) {
        const select = el('select', { className: 'settings-select', ariaLabel: label });
        for (const [choice, copy] of choices) {
            const option = el('option', { text: copy });
            option.value = choice;
            option.selected = choice === value;
            select.appendChild(option);
        }
        select.addEventListener('change', () => callback?.(select.value));
        this.controls.set(key, select);
        return this._settingRow(label, detail, select);
    }

    _range(key, label, value, callback, compact = false) {
        const normalized = Number.isFinite(Number(value)) ? Number(value) : 1;
        const input = el('input', { className: 'settings-range', ariaLabel: `${label} level` });
        input.type = 'range';
        input.min = '0';
        input.max = '10';
        input.step = '1';
        input.value = String(Math.round(Math.max(0, Math.min(1, normalized)) * 10));
        const output = el('output', { className: 'settings-range__value', text: `${input.value} / 10` });
        output.htmlFor = input.id;
        input.addEventListener('input', () => {
            output.textContent = `${input.value} / 10`;
            callback?.(Number(input.value) / 10);
        });
        this.controls.set(key, { input, output });
        const control = el('div', { className: 'settings-range-wrap' }, [input, output]);
        return this._settingRow(label, compact ? '' : 'Set the persisted level.', control);
    }

    _buildWatchtowers() {
        this.watchtowerList = el('div', {
            className: 'settings-roster',
            text: 'Reading local provider health…',
        });
        this.watchtowerList.setAttribute('aria-live', 'polite');
        return this._section('WATCHTOWERS', 'settings-section--watchtowers', [this.watchtowerList]);
    }

    async _loadProviders() {
        if (typeof this.fetchImpl !== 'function') {
            this._renderProviderError();
            return;
        }
        this._providerController?.abort?.();
        this._providerController = new AbortController();
        try {
            const response = await this.fetchImpl('/api/providers', { signal: this._providerController.signal });
            if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
            const payload = await response.json();
            const providers = Array.isArray(payload?.health)
                ? payload.health
                : (Array.isArray(payload?.providers) ? payload.providers : []);
            this.providers = providers
                .map((provider) => ({
                    id: String(provider?.id || provider?.name || 'unknown'),
                    name: String(provider?.name || provider?.id || 'Unknown'),
                    health: String(provider?.health || 'unavailable'),
                    sessions: Math.max(0, Number(provider?.sessions) || 0),
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
            this._renderProviders();
        } catch (error) {
            if (error?.name !== 'AbortError') this._renderProviderError();
        }
    }

    _renderProviderError() {
        if (!this.watchtowerList) return;
        replaceChildren(this.watchtowerList, [el('p', {
            className: 'settings-empty settings-empty--degraded',
            text: 'Provider health is unavailable.',
        })]);
    }

    _renderProviders(now = Date.now()) {
        if (!this.watchtowerList) return;
        if (this.providers.length === 0) {
            replaceChildren(this.watchtowerList, [el('p', {
                className: 'settings-empty',
                text: 'No providers were reported.',
            })]);
            return;
        }
        replaceChildren(this.watchtowerList, this.providers.map((provider) => {
            const hookAge = Number(this.getHookFreshness?.(provider.id, now));
            const hook = Number.isFinite(hookAge) && hookAge >= 0 && hookAge < HOOK_LIVE_WINDOW_MS
                ? ` · hook: live · ${ageText(hookAge)}`
                : '';
            return el('div', {
                className: `settings-provider ${providerClass(provider)}`,
            }, [
                el('span', { className: 'settings-provider__name', text: provider.name }),
                el('span', { className: 'settings-provider__state', text: `${providerState(provider)}${hook}` }),
            ]);
        }));
    }

    _buildStorage() {
        this.chronicleNotice = el('p', { className: 'settings-storage__notice' });
        this.chronicleNotice.setAttribute('role', 'status');
        return this._section('STORAGE', 'settings-section--storage', [
            el('dl', { className: 'settings-ledger' }, [
                el('dt', { text: 'Preferences, names, pins' }),
                el('dd', { text: 'Browser storage · survives reload' }),
                el('dt', { text: 'Chronicle and spend ledger' }),
                el('dd', { text: 'IndexedDB · survives reload' }),
                el('dt', { text: 'Live sessions and hook detail' }),
                el('dd', { text: 'Memory only · cleared on reload' }),
            ]),
            this.chronicleNotice,
        ]);
    }

    _buildPricing() {
        this.pricingState = el('span', { className: 'settings-pricing__state' });
        return this._section('PRICING', 'settings-section--pricing', [
            el('div', { className: 'settings-fact-row' }, [
                el('span', { className: 'settings-fact-row__label', text: 'Model pricing table' }),
                el('span', { className: 'settings-fact-row__value' }, [
                    `revision ${TokenUsage.rateRevision} · `,
                    this.pricingState,
                ]),
            ]),
        ]);
    }

    _buildHealth() {
        this.healthLink = el('span', { className: 'settings-fact-row__value' });
        this.healthSnapshot = el('span', { className: 'settings-fact-row__value' });
        this.healthFrames = el('span', { className: 'settings-fact-row__value' });
        this.healthLoop = el('span', { className: 'settings-fact-row__value' });
        const row = (label, value) => el('div', { className: 'settings-fact-row' }, [
            el('span', { className: 'settings-fact-row__label', text: label }),
            value,
        ]);
        return this._section('HEALTH', 'settings-section--health', [
            row('Link', this.healthLink),
            row('Last snapshot', this.healthSnapshot),
            row('Render', this.healthFrames),
            row('Event-loop delay', this.healthLoop),
        ]);
    }

    _refreshOperationalRows() {
        const now = Date.now();
        const state = this.getVillageState?.();
        if (this.healthLink) this.healthLink.textContent = linkStatusText(state, now).toLowerCase();
        if (this.healthSnapshot) this.healthSnapshot.textContent = ageText(snapshotAgeMs(state, now));

        let frameHealth = null;
        try { frameHealth = globalThis.window?.__claudeVillePerf?.frameHealth?.() || null; } catch { /* diagnostics only */ }
        const metrics = getClientPerfMetrics()?.getSnapshot?.() || null;
        const p50 = oneDecimal(metrics?.frames?.p50Ms);
        const p95 = oneDecimal(metrics?.frames?.p95Ms ?? frameHealth?.p95FrameGapMs);
        // A suspended render loop reports null; Number(null) is 0, which would
        // read as a genuine 0 FPS stall, so only real numbers count as samples.
        const fps = this.getCurrentFps?.();
        const fpsText = typeof fps === 'number' && Number.isFinite(fps)
            ? `${Math.round(fps)} FPS`
            : 'render loop idle';
        if (this.healthFrames) {
            this.healthFrames.textContent = `${fpsText} · frame p50 ${p50 ?? 'collecting'} ms · p95 ${p95 ?? 'collecting'} ms`;
        }
        const loopDelay = oneDecimal(frameHealth?.p95HostGapMs ?? frameHealth?.emaHostGapMs);
        if (this.healthLoop) this.healthLoop.textContent = `${loopDelay ?? 'collecting'} ms`;

        const chronicleStatus = String(this.getChronicleStatus?.() || 'unknown');
        if (this.chronicleNotice) {
            this.chronicleNotice.classList.toggle('settings-storage__notice--degraded', chronicleStatus === 'degraded');
            this.chronicleNotice.textContent = chronicleStatus === 'degraded'
                ? 'Chronicle degraded: history and today’s persisted ledger may be unavailable.'
                : `Chronicle: ${chronicleStatus}`;
        }
        if (this.pricingState) {
            this.pricingState.textContent = this.unknownModelSeenToday?.()
                ? 'unknown model seen today · default rate used'
                : 'all models matched today';
            this.pricingState.classList.toggle('settings-pricing__state--unknown', Boolean(this.unknownModelSeenToday?.()));
        }
        this._renderProviders(now);
    }

    _buildActions() {
        const reset = el('button', {
            className: 'settings-actions__reset',
            text: 'RESET TO DEFAULTS',
            ariaLabel: 'Reset persisted settings to defaults',
        });
        reset.type = 'button';
        reset.addEventListener('click', async () => {
            reset.disabled = true;
            try {
                await this.onReset?.();
                this.syncControls();
            } finally {
                reset.disabled = false;
                reset.focus();
            }
        });
        return el('div', { className: 'settings-actions' }, [
            reset,
            el('span', {
                className: 'settings-actions__note',
                text: 'Session history, names, pins, and Chronicle data are kept.',
            }),
        ]);
    }

    syncControls() {
        const settings = this.readSettings?.() || {};
        for (const key of ['soundEnabled', 'autoCamera', 'desktopAlerts', 'sidebarCollapsed', 'reducedMotion']) {
            const input = this.controls.get(key);
            if (input) input.checked = Boolean(settings[key]);
        }
        const mode = this.controls.get('soundMode');
        if (mode) mode.value = settings.soundMode || 'ambient';
        this._syncRange('soundVolume', settings.soundVolume);
        for (const [name] of SOUND_LAYERS) this._syncRange(`soundLayer:${name}`, settings.soundLayers?.[name]);
        this._refreshOperationalRows();
    }

    _syncRange(key, value) {
        const control = this.controls.get(key);
        if (!control) return;
        const normalized = Number.isFinite(Number(value)) ? Number(value) : 1;
        control.input.value = String(Math.round(Math.max(0, Math.min(1, normalized)) * 10));
        control.output.textContent = `${control.input.value} / 10`;
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._providerController?.abort?.();
        this._providerController = null;
        if (this._refreshTimer) globalThis.clearInterval?.(this._refreshTimer);
        this._refreshTimer = null;
        if (this._metricsStartedHere) getClientPerfMetrics()?.stop?.();
        this._metricsStartedHere = false;
        this.root = null;
    }
}
