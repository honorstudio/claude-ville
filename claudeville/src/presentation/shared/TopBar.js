import { eventBus } from '../../domain/events/DomainEvent.js';
import { formatCost, formatNumber, shortProjectName } from './Formatters.js';
import { el, replaceChildren } from './DomSafe.js';
import {
    installReducedMotionOverride,
    readReducedMotionOverride,
    SettingsPanel,
} from './SettingsPanel.js';
import {
    initialVillageState,
    isStale,
    LinkState,
    linkStatusText,
    snapshotAgeMs,
} from '../../application/VillageState.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { eventShapeSvgPath } from './EventShapes.js';

const SETTINGS_MODAL_OWNER = 'topbar-settings';
const UNKNOWN_MODEL_DATE_KEY = 'claudeville.pricing.unknownModelDate';
const AUDIO_LAYER_LEVELS_KEY = 'claudeville.sound.layers';
const AUDIO_MIXER_DEFAULTS = Object.freeze({
    wind: 1,
    rain: 1,
    wildlife: 1,
    hum: 1,
    music: 1,
});

function readStoredLayerLevels(storage = globalThis.window?.localStorage) {
    try {
        const parsed = JSON.parse(storage?.getItem(AUDIO_LAYER_LEVELS_KEY) || '{}');
        return Object.fromEntries(Object.entries(AUDIO_MIXER_DEFAULTS).map(([name, fallback]) => {
            const value = Number(parsed?.[name]);
            return [name, Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback];
        }));
    } catch {
        return { ...AUDIO_MIXER_DEFAULTS };
    }
}

const CONNECTION_REASON_COPY = Object.freeze({
    'connection-refused': 'The local session link refused the connection.',
    'econnrefused': 'The local session link refused the connection.',
    'connection-reset': 'The local session link was reset.',
    'econnreset': 'The local session link was reset.',
    'socket-closed': 'The local session link closed unexpectedly.',
    'socket-error': 'The local session link reported a transport problem.',
    'websocket-closed': 'The local session link closed unexpectedly.',
    'initial-sync-failed': 'The initial local session sync did not complete.',
    'message-invalid': 'A session update could not be understood.',
    'delta-baseline-mismatch': 'A session update did not match the last snapshot.',
    'patch-failed': 'A session update could not be applied safely.',
    'watcher-unavailable': 'The local session watcher is unavailable.',
    'watcher-failed': 'The local session watcher could not read session updates.',
    'poll-timeout': 'The local session poll took too long.',
    'session-poll-failed': 'The local session watcher could not refresh sessions.',
    'poll-failed': 'The local session watcher could not complete a refresh.',
    'source-failed': 'A local session source could not be read.',
    'timeout': 'The local session link timed out.',
    'timed-out': 'The local session link timed out.',
});

/** Safe operator copy from a normalized code; raw diagnostic text never passes through. */
export function connectionReasonText(code) {
    const normalized = String(code || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return CONNECTION_REASON_COPY[normalized] || 'Connection interrupted; ClaudeVille will keep retrying locally.';
}

export const PERSISTED_SETTING_DEFAULTS = Object.freeze({
    'claudeville.sound.enabled': 'false',
    'claudeville.sound.volume': '0.5',
    'claudeville.sound.mode': 'ambient',
    'claudeville.sound.layers': JSON.stringify(AUDIO_MIXER_DEFAULTS),
    'cv-auto-camera': '1',
    'claudeville.alerts.desktop': '0',
    'claudeville.sidebarCollapsed': 'false',
});

function storageValue(storage, key) {
    try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function focusWithoutScroll(element) {
    if (!element?.focus) return;
    try { element.focus({ preventScroll: true }); } catch { element.focus(); }
}

export function readPersistedSettings(storage = globalThis.window?.localStorage) {
    const storedVolume = storageValue(storage, 'claudeville.sound.volume');
    const rawVolume = storedVolume === null ? NaN : Number(storedVolume);
    const volume = Number.isFinite(rawVolume)
        ? Math.max(0, Math.min(1, rawVolume))
        : 0.5;
    const rawMode = storageValue(storage, 'claudeville.sound.mode');
    return {
        soundEnabled: storageValue(storage, 'claudeville.sound.enabled') === 'true',
        soundVolume: volume,
        soundMode: rawMode === 'bgm' ? 'bgm' : 'ambient',
        soundLayers: readStoredLayerLevels(storage),
        autoCamera: storageValue(storage, 'cv-auto-camera') !== '0',
        desktopAlerts: storageValue(storage, 'claudeville.alerts.desktop') === '1',
        sidebarCollapsed: storageValue(storage, 'claudeville.sidebarCollapsed') === 'true',
    };
}

export function resetPersistedSettings(storage = globalThis.window?.localStorage) {
    for (const [key, value] of Object.entries(PERSISTED_SETTING_DEFAULTS)) {
        try { storage?.setItem(key, value); } catch { /* persistence is optional */ }
    }
    return readPersistedSettings(storage);
}

export function usageCoverage(agents = []) {
    const counts = { observed: 0, partial: 0, unavailable: 0 };
    for (const agent of agents) {
        const availability = TokenUsage.normalize(agent?.tokens).availability;
        counts[availability]++;
    }
    return counts;
}

export class TopBar {
    constructor(world, { modal, attention, chronicle, spendLedger, frameAttention } = {}) {
        this._motionOverride = installReducedMotionOverride();
        this.world = world;
        this.modal = modal || null;
        this.attention = attention || null;
        this.frameAttention = frameAttention;
        this.chronicle = chronicle || null;
        this.spendLedger = spendLedger || null;
        this.els = {
            root: document.getElementById('topbar'),
            tokens: document.getElementById('statTokens'),
            time: document.getElementById('statTime'),
            clock: document.getElementById('villageClock'),
            working: document.getElementById('badgeWorking'),
            idle: document.getElementById('badgeIdle'),
            waiting: document.getElementById('badgeWaiting'),
            connection: document.getElementById('topbarConnection'),
            version: document.querySelector('.topbar__version'),
            soundToggle: document.getElementById('topbarSoundToggle'),
            soundMode: document.getElementById('topbarSoundMode'),
            soundVolume: document.getElementById('topbarSoundVolume'),
            cinemaToggle: document.getElementById('topbarCinemaToggle'),
            alertsToggle: document.getElementById('topbarAlertsToggle'),
            chronicleBtn: document.getElementById('topbarChronicle'),
            rate: document.getElementById('statRate'),
            rateWrap: document.getElementById('statRateWrap'),
            quotaWrap: document.getElementById('statQuotaWrap'),
            quota5h: document.getElementById('statQuota5h'),
            quota7d: document.getElementById('statQuota7d'),
            quotaText: document.getElementById('statQuotaText'),
        };
        this.els.needsYou = el('span', {
            className: 'topbar__seg topbar__seg--needs-you',
            title: 'Agents waiting for your input or approval',
        });
        this.els.needsYou.id = 'badgeNeedsYou';
        this.els.needsYou.hidden = true;
        this.els.waiting?.parentElement?.parentElement?.prepend(this.els.needsYou);
        this._usage = null;
        this.timeInterval = null;
        this._lastFps = null;
        this._settingsPanel = null;
        this._hookSeenAtByProvider = new Map();
        this._chronicleStatus = 'unknown';
        this._changelogHtml = null;
        this._changelogController = null;
        this._destroyed = false;
        this._villageState = initialVillageState();
        this._connectionAnnouncementKey = null;
        this._recoverySweepPending = false;
        this._recoveryBaselineSnapshotAt = null;
        this._lastSweptSnapshotAt = null;
        this._staleTimer = null;
        const audioMixer = this._buildAudioMixer();
        this.audio = null;
        this._audioLoadPromise = null;
        this._audioOptions = {
            button: this.els.soundToggle,
            modeButton: this.els.soundMode,
            volumeSlider: this.els.soundVolume,
            mixerButton: audioMixer.button,
            mixerPanel: audioMixer.panel,
            layerControls: audioMixer.controls,
            world: this.world,
        };
        this._bindDeferredAudio();
        this._initCinemaToggle();
        this._initAttentionControls();
        this._initChronicleButton();
        this._initSpendBreakdown();
        this._initSettingsButton();

        this._onUpdate = (agent) => {
            this._observeHookSignal(agent);
            this.render();
        };
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

        this._onFps = (fps) => this.renderFps(fps);
        eventBus.on('fps:updated', this._onFps);
        this._onAtmosphere = snapshot => this._renderWitnessClock(snapshot);
        eventBus.on('atmosphere:updated', this._onAtmosphere);

        this._onUsage = (usage) => { this._usage = usage; this._renderQuota(); };
        eventBus.on('usage:updated', this._onUsage);

        this._onVillageState = (state) => {
            if (!state?.link) return;
            this._villageState = state;
            const connected = state.source === 'simulator'
                || (Boolean(state.link.lastSnapshotAt) && !isStale(state)
                    && [LinkState.LIVE, LinkState.POLLING].includes(state.link.state));
            this._applyConnectionChrome(connected);
            this._renderConnection();
        };
        eventBus.on('village:state', this._onVillageState);
        this._onChronicleStatus = (payload = {}) => {
            this._chronicleStatus = String(payload.status || 'unknown');
        };
        eventBus.on('chronicle:status', this._onChronicleStatus);
        this._initConnectionInstrument();

        if (this.modal && this.els.version) {
            this.els.version.title = 'View changelog';
            this._onVersionClick = () => this._openChangelog();
            this.els.version.addEventListener('click', this._onVersionClick);
            this._onVersionKeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.key === ' ') e.preventDefault();
                    this._openChangelog();
                }
            };
            this.els.version.addEventListener('keydown', this._onVersionKeydown);
        }

        this._startTimer();
        this.render();
    }

    _renderWitnessClock(snapshot) {
        const clock = snapshot?.clock;
        const node = this.els.clock;
        if (!node || !clock?.label) return;
        const weather = snapshot.weather?.type || 'clear';
        const timeline = snapshot.timeline;
        const override = timeline?.hourOverride != null || timeline?.frozen || timeline?.mode === 'fixed'
            ? 'FIXED' : this._villageState.source === 'simulator' ? 'SIM' : '';
        const phase = String(snapshot.phase || '').toUpperCase();
        const signature = `${clock.label}|${phase}|${weather}|${override}`;
        if (signature === this._clockSignature) return;
        this._clockSignature = signature;
        node.hidden = false;
        node.querySelector('.topbar__clock-time').textContent = clock.label;
        node.querySelector('.topbar__clock-phase').textContent = phase;
        const tag = node.querySelector('.topbar__clock-override');
        tag.textContent = override;
        tag.hidden = !override;
        const glyph = /rain|storm|snow/.test(weather) ? 'weather-rain'
            : /cloud|fog|overcast/.test(weather) ? 'weather-cloud' : 'weather-clear';
        node.querySelector('path').setAttribute('d', eventShapeSvgPath(glyph));
        node.title = `Modeled village weather: ${weather}${override ? ` · ${override.toLowerCase()} timeline` : ''}`;
    }

    // #attract — topbar toggle for the idle action camera (on by default,
    // persisted). Emits `camera:auto-camera` which the World renderer consumes;
    // also reflects the state if it is flipped elsewhere.
    _initCinemaToggle() {
        const btn = this.els.cinemaToggle;
        if (!btn) return;
        const read = () => {
            try { return window.localStorage?.getItem('cv-auto-camera') !== '0'; } catch (_) { return true; }
        };
        const apply = (on) => {
            btn.classList.toggle('topbar__cinema-btn--on', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.title = on ? 'Auto-camera on: frames live action when idle' : 'Auto-camera off';
        };
        apply(read());
        this._onCinemaClick = () => {
            const next = !read();
            try { window.localStorage?.setItem('cv-auto-camera', next ? '1' : '0'); } catch (_) { /* storage unavailable */ }
            apply(next);
            eventBus.emit('camera:auto-camera', { enabled: next });
        };
        btn.addEventListener('click', this._onCinemaClick);
        this._onAutoCamera = (payload) => apply(payload?.enabled !== false);
        eventBus.on('camera:auto-camera', this._onAutoCamera);
    }

    // The `A` hotkey jumps to the longest-waiting actionable agent, and ALERTS
    // opts into desktop notifications from a real user gesture (browsers reject
    // permission prompts otherwise).
    _initAttentionControls() {
        if (!this.attention) return;

        const btn = this.els.alertsToggle;
        if (btn) {
            if (!this.attention.desktopAlertsAvailable) {
                btn.hidden = true;
            } else {
                this._applyAlertsState(this.attention.desktopAlerts);
                this._onAlertsClick = async () => {
                    const on = await this.attention.setDesktopAlerts(!this.attention.desktopAlerts);
                    this._applyAlertsState(on);
                    if (!on && Notification.permission === 'denied') {
                        btn.title = 'Blocked by the browser — allow notifications for localhost:4000';
                    }
                };
                btn.addEventListener('click', this._onAlertsClick);
            }
        }

        this._onAttentionKey = (event) => {
            if (event.key !== 'a' && event.key !== 'A') return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
            if (this.frameAttention?.()) {
                event.preventDefault();
                return;
            }
            const agent = this.attention.focusNext();
            if (agent) event.preventDefault();
        };
        document.addEventListener('keydown', this._onAttentionKey);
    }

    _applyAlertsState(on) {
        const btn = this.els.alertsToggle;
        if (!btn) return;
        btn.classList.toggle('topbar__sound-btn--on', Boolean(on));
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.title = on ? 'Disable desktop notifications' : 'Enable desktop notifications';
    }

    _initChronicleButton() {
        const btn = this.els.chronicleBtn;
        if (!btn) return;
        if (!this.chronicle) { btn.hidden = true; return; }
        this._onChronicleClick = () => {
            this.chronicle.open().catch((err) => {
                console.warn('[TopBar] Chronicle unavailable:', err.message);
            });
        };
        btn.addEventListener('click', this._onChronicleClick);
    }

    _initSettingsButton() {
        if (!this.modal || !this.els.root) return;
        const anchor = document.getElementById('topbarWorldControls') || this.els.soundMode;
        if (!anchor?.parentElement) return;
        const button = el('button', {
            className: 'topbar__sound-btn topbar__icon-btn topbar__icon-btn--action',
            title: 'Settings and health',
            ariaLabel: 'Open settings',
        });
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'dialog');
        button.appendChild(el('span', { className: 'topbar__settings-icon' }));
        this._onSettingsClick = () => this._openSettings();
        button.addEventListener('click', this._onSettingsClick);
        anchor.insertAdjacentElement('afterend', button);
        this._settingsButtonEl = button;
    }

    _openSettings() {
        if (!this.modal || this._destroyed) return;
        this._hideMixerPanel({ restoreFocus: false });
        this._hideSpendPanel({ restoreFocus: false });
        this.modal.openContent('Settings', this._buildSettingsContent(), {
            wide: true,
            owner: SETTINGS_MODAL_OWNER,
        });
    }

    _buildSettingsContent() {
        this._settingsPanel?.destroy();
        this._settingsPanel = new SettingsPanel({
            readSettings: () => ({
                ...readPersistedSettings(),
                reducedMotion: readReducedMotionOverride(),
            }),
            onSoundEnabled: (enabled) => this._setSoundEnabled(enabled),
            onSoundMode: (mode) => this._setSoundMode(mode),
            onSoundVolume: (volume) => this._setSoundVolume(volume),
            onSoundLayer: (name, value) => this._setSoundLayer(name, value),
            onAutoCamera: (enabled) => this._setAutoCamera(enabled),
            onDesktopAlerts: (enabled) => this._setDesktopAlerts(enabled),
            onSidebarCollapsed: (collapsed) => this._setSidebarCollapsed(collapsed),
            onReducedMotion: (reduced) => this._setReducedMotion(reduced),
            onReset: () => this._resetSettings(),
            getVillageState: () => this._villageState,
            getChronicleStatus: () => globalThis.window?.__chronicle?.status || this._chronicleStatus,
            getCurrentFps: () => this._lastFps,
            getHookFreshness: (provider, now) => this._hookFreshness(provider, now),
            unknownModelSeenToday: () => this._unknownModelSeenToday(),
            alertsAvailable: this.attention?.desktopAlertsAvailable === true,
        });
        return this._settingsPanel.build();
    }

    _resetSettings() {
        resetPersistedSettings();
        this._setReducedMotion(false);
        this.audio?.setEnabled(false);
        this.audio?.setVolume(0.5);
        this.audio?.setMode('ambient');
        for (const [name, value] of Object.entries(AUDIO_MIXER_DEFAULTS)) {
            this.audio?.setLayerLevel(name, value);
        }
        if (!this.audio) this._renderDeferredAudioControl();
        eventBus.emit('camera:auto-camera', { enabled: true });
        if (this.attention) {
            void this.attention.setDesktopAlerts(false).then((on) => this._applyAlertsState(on));
        }
        const sidebar = document.getElementById('sidebar');
        if (sidebar?.classList.contains('sidebar--collapsed')) {
            document.getElementById('sidebarToggle')?.click();
        }
        this._settingsPanel?.syncControls();
    }

    async _setSoundEnabled(enabled) {
        try {
            const audio = await this._ensureAudio();
            audio?.setEnabled(Boolean(enabled));
            return Boolean(audio?.enabled);
        } catch (error) {
            console.warn('[TopBar] Audio unavailable:', error.message);
            this._renderDeferredAudioControl();
            return false;
        }
    }

    async _setSoundMode(mode) {
        try {
            const audio = await this._ensureAudio();
            audio?.setMode(mode);
            return audio?.mode || 'ambient';
        } catch (error) {
            console.warn('[TopBar] Audio unavailable:', error.message);
            return readPersistedSettings().soundMode;
        }
    }

    async _setSoundVolume(volume) {
        try {
            const audio = await this._ensureAudio();
            audio?.setVolume(volume);
            return audio?.volume ?? 0.5;
        } catch (error) {
            console.warn('[TopBar] Audio unavailable:', error.message);
            return readPersistedSettings().soundVolume;
        }
    }

    async _setSoundLayer(name, value) {
        try {
            const audio = await this._ensureAudio();
            audio?.setLayerLevel(name, value);
            return audio?.layerLevels?.[name] ?? value;
        } catch (error) {
            console.warn('[TopBar] Audio unavailable:', error.message);
            return readPersistedSettings().soundLayers[name];
        }
    }

    _setAutoCamera(enabled) {
        const next = Boolean(enabled);
        const current = readPersistedSettings().autoCamera;
        if (current !== next && this.els.cinemaToggle) this.els.cinemaToggle.click();
        else if (current !== next) {
            try { window.localStorage?.setItem('cv-auto-camera', next ? '1' : '0'); } catch { /* persistence is optional */ }
            eventBus.emit('camera:auto-camera', { enabled: next });
        }
        return readPersistedSettings().autoCamera;
    }

    async _setDesktopAlerts(enabled) {
        if (!this.attention?.desktopAlertsAvailable) return false;
        const on = await this.attention.setDesktopAlerts(Boolean(enabled));
        this._applyAlertsState(on);
        return on;
    }

    _setSidebarCollapsed(collapsed) {
        const next = Boolean(collapsed);
        const sidebar = document.getElementById('sidebar');
        const current = sidebar?.classList.contains('sidebar--collapsed')
            ?? readPersistedSettings().sidebarCollapsed;
        if (current !== next) document.getElementById('sidebarToggle')?.click();
        return document.getElementById('sidebar')?.classList.contains('sidebar--collapsed') ?? next;
    }

    _setReducedMotion(reduced) {
        this._motionOverride = this._motionOverride || installReducedMotionOverride();
        return this._motionOverride?.set(Boolean(reduced)) ?? Boolean(reduced);
    }

    _observeHookSignal(agent) {
        if (agent?.signalSource !== 'hook') return;
        const provider = String(agent.provider || '').trim().toLowerCase();
        if (provider) this._hookSeenAtByProvider.set(provider, Date.now());
    }

    _hookFreshness(provider, now = Date.now()) {
        const seenAt = this._hookSeenAtByProvider.get(String(provider || '').trim().toLowerCase());
        return Number.isFinite(seenAt) ? Math.max(0, now - seenAt) : null;
    }

    _unknownModelSeenToday() {
        const date = new Date();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const today = `${date.getFullYear()}-${month}-${day}`;
        const agents = this.world?.agents?.values?.() || [];
        if ([...agents].some((agent) => agent.cost?.unknownModel === true)) {
            try { window.localStorage?.setItem(UNKNOWN_MODEL_DATE_KEY, today); } catch { /* persistence is optional */ }
            return true;
        }
        return storageValue(globalThis.window?.localStorage, UNKNOWN_MODEL_DATE_KEY) === today;
    }

    _closeSettings() {
        if (this.modal?.isOpen(SETTINGS_MODAL_OWNER)) this.modal.close();
    }

    _bindDeferredAudio() {
        const button = this.els.soundToggle;
        if (!button) return;
        this._onDeferredAudioClick = (event) => {
            event.preventDefault();
            if (this._audioLoadPromise) return;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            void this._ensureAudio().then((audio) => {
                if (audio && !this._destroyed) return audio.setEnabled(!audio.enabled);
                return null;
            }).catch((error) => {
                console.warn('[TopBar] Audio unavailable:', error.message);
            }).finally(() => {
                if (!button.isConnected) return;
                button.disabled = false;
                button.removeAttribute('aria-busy');
            });
        };
        button.addEventListener('click', this._onDeferredAudioClick);
        this._renderDeferredAudioControl();
    }

    _renderDeferredAudioControl() {
        const button = this.els.soundToggle;
        if (!button) return;
        const enabled = storageValue(globalThis.window?.localStorage, 'claudeville.sound.enabled') === 'true';
        button.setAttribute('aria-pressed', String(enabled));
        button.classList.toggle('topbar__sound-btn--on', enabled);
        button.title = enabled ? 'Disable sound' : 'Enable sound';
    }

    _ensureAudio() {
        if (this.audio) return Promise.resolve(this.audio);
        if (!this._audioLoadPromise) {
            this._audioLoadPromise = import('./AmbientAudioController.js').then((module) => {
                if (this._destroyed) return null;
                this.els.soundToggle?.removeEventListener('click', this._onDeferredAudioClick);
                this._onDeferredAudioClick = null;
                this.audio = new module.AmbientAudioController(this._audioOptions);
                return this.audio;
            }).catch((error) => {
                this._audioLoadPromise = null;
                throw error;
            });
        }
        return this._audioLoadPromise;
    }

    // The topbar remains a glance surface: one compact chip opens the deeper
    // mix below it. The fixed panel is right-anchored, escapes the topbar's
    // overflow clipping, and never shares the screen with the Spend Map.
    _buildAudioMixer() {
        const anchor = this.els.soundVolume;
        if (!anchor || !document.body) return { button: null, panel: null, controls: {} };

        const button = el('button', {
            className: 'topbar__sound-btn',
            text: 'MIX',
            title: 'Open soundscape mixer',
            ariaLabel: 'Open soundscape mixer',
            style: { padding: '6px 7px', letterSpacing: '0.5px' },
        });
        button.type = 'button';
        button.hidden = true;
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', 'audioMixerPanel');
        button.setAttribute('aria-expanded', 'false');
        anchor.insertAdjacentElement('afterend', button);

        const panel = el('div', {
            className: 'topbar__mixer-panel',
            ariaLabel: 'Soundscape mixer',
            style: {
                position: 'fixed',
                display: 'none',
                zIndex: '1200',
                boxSizing: 'border-box',
                width: '308px',
                padding: '11px',
                border: '1px solid var(--cv-gold-warm, #c79d4c)',
                borderRadius: '2px',
                background: 'linear-gradient(180deg, var(--cv-panel, #211811), #17100c)',
                boxShadow: '0 0 0 2px rgba(28, 17, 11, 0.96), var(--cv-elev-2)',
                color: 'var(--cv-tan, #d6c09c)',
            },
        });
        panel.id = 'audioMixerPanel';
        panel.setAttribute('role', 'dialog');
        panel.tabIndex = -1;

        const heading = el('div', {
            className: 'topbar__mixer-heading',
            text: 'SOUNDSCAPE MIXER',
        });
        const note = el('div', {
            className: 'topbar__mixer-note',
            text: 'Layer trims · master volume still applies',
        });
        const rows = el('div', {
            style: {
                borderTop: '1px solid rgba(199, 157, 76, 0.22)',
            },
        });
        const controls = {};
        const layers = [
            ['wind', 'WIND'],
            ['rain', 'RAIN'],
            ['wildlife', 'WILDLIFE'],
            ['hum', 'VILLAGE HUM'],
            ['music', 'MUSIC'],
        ];
        for (const [name, label] of layers) {
            const slider = el('input', {
                className: 'topbar__sound-vol',
                ariaLabel: `${label.toLowerCase()} level`,
                style: { width: '142px' },
            });
            slider.type = 'range';
            slider.min = '0';
            slider.max = '100';
            slider.step = '1';
            slider.value = '100';
            const value = el('span', {
                text: '100%',
                style: { color: 'var(--cv-text-muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
            });
            rows.appendChild(el('label', {
                className: 'topbar__mixer-row',
                style: {
                    display: 'grid',
                    gridTemplateColumns: '78px 1fr 34px',
                    gap: '7px',
                    alignItems: 'center',
                    minHeight: '32px',
                    borderBottom: '1px solid rgba(199, 157, 76, 0.12)',
                },
            }, [label, slider, value]));
            controls[name] = { slider, value };
        }
        panel.append(heading, note, rows);
        document.body.appendChild(panel);

        this._mixerButtonEl = button;
        this._mixerPanelEl = panel;
        this._onMixerClick = (event) => {
            event.stopPropagation();
            this._toggleMixerPanel();
        };
        this._onMixerKeydown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this._hideMixerPanel();
        };
        this._onMixerPanelKeydown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this._hideMixerPanel();
        };
        this._onMixerFocusOut = (event) => {
            if (panel.style.display === 'none') return;
            const next = event.relatedTarget;
            if (next && (panel.contains?.(next) || button.contains?.(next))) return;
            // Focus is already moving to the next surface; do not steal it
            // back while dismissing a popover because focus left it.
            this._hideMixerPanel({ restoreFocus: false });
        };
        this._onMixerOutside = (event) => {
            if (panel.style.display === 'none') return;
            if (!panel.contains(event.target) && !button.contains(event.target)) {
                this._hideMixerPanel({ restoreFocus: false });
            }
        };
        this._onMixerResize = () => this._hideMixerPanel({ restoreFocus: false });
        button.addEventListener('click', this._onMixerClick);
        button.addEventListener('keydown', this._onMixerKeydown);
        panel.addEventListener('keydown', this._onMixerPanelKeydown);
        button.addEventListener('focusout', this._onMixerFocusOut);
        panel.addEventListener('focusout', this._onMixerFocusOut);
        document.addEventListener('pointerdown', this._onMixerOutside);
        window.addEventListener('resize', this._onMixerResize);
        return { button, panel, controls };
    }

    _toggleMixerPanel() {
        if (!this._mixerPanelEl) return;
        if (this._mixerPanelEl.style.display === 'none') this._showMixerPanel();
        else this._hideMixerPanel();
    }

    _showMixerPanel() {
        if (this._destroyed || !this._mixerButtonEl || !this._mixerPanelEl) return;
        this._closeSettings?.();
        this._hideSpendPanel({ restoreFocus: false });
        const rect = this._mixerButtonEl.getBoundingClientRect();
        const panelWidth = 308;
        this._mixerPanelEl.style.left = `${Math.max(8, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 8))}px`;
        this._mixerPanelEl.style.top = `${rect.bottom + 7}px`;
        this._mixerPanelEl.style.display = 'block';
        this._mixerButtonEl.setAttribute('aria-expanded', 'true');
        this._mixerButtonEl.classList.add('topbar__sound-btn--on');
        const firstControl = this._mixerPanelEl.querySelector?.(
            'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        );
        focusWithoutScroll(firstControl || this._mixerPanelEl);
    }

    _hideMixerPanel({ restoreFocus = true } = {}) {
        const wasOpen = this._mixerPanelEl?.style.display !== 'none';
        if (this._mixerPanelEl) this._mixerPanelEl.style.display = 'none';
        this._mixerButtonEl?.setAttribute('aria-expanded', 'false');
        this._mixerButtonEl?.classList.remove('topbar__sound-btn--on');
        if (restoreFocus && wasOpen) focusWithoutScroll(this._mixerButtonEl);
    }

    // Keep the thin topbar as the glance surface; its TODAY cell opens a
    // stable, inspectable spend map rather than trying to squeeze project names
    // between status badges. Click (rather than hover) also gives keyboard
    // users and operators chasing a spike time to read the rows.
    _initSpendBreakdown() {
        const trigger = this.els.rateWrap;
        if (!trigger || !this.spendLedger) return;
        trigger.tabIndex = 0;
        trigger.setAttribute('role', 'button');
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-controls', 'spendBreakdownPanel');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.title = 'Open project and provider spend map';
        this._onSpendClick = (event) => {
            event.stopPropagation();
            this._toggleSpendPanel();
        };
        this._onSpendKeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this._hideSpendPanel();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this._toggleSpendPanel();
            }
        };
        this._onSpendPanelKeydown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this._hideSpendPanel();
        };
        this._onSpendFocusOut = (event) => {
            if (!this._spendPanelEl || this._spendPanelEl.style.display === 'none') return;
            const next = event.relatedTarget;
            if (next && (this._spendPanelEl.contains?.(next) || trigger.contains?.(next))) return;
            this._hideSpendPanel({ restoreFocus: false });
        };
        this._onSpendOutside = (event) => {
            if (!this._spendPanelEl || this._spendPanelEl.style.display === 'none') return;
            if (!this._spendPanelEl.contains(event.target) && !trigger.contains(event.target)) {
                this._hideSpendPanel({ restoreFocus: false });
            }
        };
        this._onSpendResize = () => this._hideSpendPanel({ restoreFocus: false });
        trigger.addEventListener('click', this._onSpendClick);
        trigger.addEventListener('keydown', this._onSpendKeydown);
        trigger.addEventListener('focusout', this._onSpendFocusOut);
        document.addEventListener('pointerdown', this._onSpendOutside);
        window.addEventListener('resize', this._onSpendResize);
    }

    render() {
        const stats = this.world.getStats();
        for (const agent of this.world?.agents?.values?.() || []) this._observeHookSignal(agent);
        this._unknownModelSeenToday();

        this._renderSpend();
        this.els.working.textContent = stats.working;
        this.els.idle.textContent = stats.idle;
        this.els.waiting.textContent = stats.waiting;
        if (this.els.needsYou) {
            this.els.needsYou.hidden = !(stats.needsYou > 0);
            this.els.needsYou.textContent = `${stats.needsYou || 0} NEEDS YOU`;
        }

        this._renderActivityRail(stats);
    }

    // Today's observed spend, the live burn rate, and quota headroom — the
    // three numbers that answer "am I burning tokens?". The old readout summed
    // the lifetime cost of whichever sessions happened to be resident, which
    // moved for reasons that had nothing to do with spending.
    _renderSpend() {
        const now = Date.now();
        const today = this.spendLedger?.sample?.(now) || { tokens: 0, cacheRead: 0, cost: 0 };
        const coverage = usageCoverage(this.world?.agents?.values?.() || []);
        const incomplete = coverage.partial + coverage.unavailable;
        this._coverageNote = incomplete ? `Partial coverage: ${coverage.partial} partial, ${coverage.unavailable} unavailable among current sessions.` : '';
        this.els.tokens.textContent = `${formatNumber(today.tokens)}${incomplete ? ' · partial' : ''}`;


        // The rate rides alongside today's total in one cell — two numbers
        // about the same thing, and the topbar has no width to spare.
        const rate = this.spendLedger?.burnRate?.(now);
        this._spendRollups = this.spendLedger?.rollups?.(now) || { projects: [], providers: [] };
        this.els.rate.textContent = rate ? `${formatNumber(Math.round(rate.tokensPerHour))}/h` : '';
        if (this.els.rateWrap) {
            this.els.rateWrap.title = rate
                ? `Tokens observed today, now running at about ~${formatCost(rate.costPerHour)}/hour at estimated API rates. Rate match: mixed session models; revision ${TokenUsage.rateRevision}. Click for project and provider detail.`
                : 'Tokens observed today by this page. A burn rate appears after a couple of minutes of activity. Click for project and provider detail.';
        }
        if (this.els.rateWrap && this._coverageNote) this.els.rateWrap.title += ` ${this._coverageNote}`;
        if (this._spendPanelEl?.style.display !== 'none') this._renderSpendPanel();
    }

    _ensureSpendPanel() {
        if (this._spendPanelEl || !document.body) return;
        this._spendPanelEl = el('div', {
            className: 'topbar__spend-panel',
            ariaLabel: 'Spend by project and provider',
            style: { display: 'none' },
        });
        this._spendPanelEl.id = 'spendBreakdownPanel';
        this._spendPanelEl.setAttribute('role', 'dialog');
        this._spendPanelEl.tabIndex = -1;
        this._spendPanelEl.addEventListener('keydown', this._onSpendPanelKeydown);
        this._spendPanelEl.addEventListener('focusout', this._onSpendFocusOut);
        document.body.appendChild(this._spendPanelEl);
    }

    _toggleSpendPanel() {
        this._ensureSpendPanel();
        if (!this._spendPanelEl) return;
        if (this._spendPanelEl.style.display === 'none') this._showSpendPanel();
        else this._hideSpendPanel();
    }

    _showSpendPanel() {
        if (this._destroyed || !this.els.rateWrap) return;
        this._closeSettings?.();
        this._hideMixerPanel({ restoreFocus: false });
        this._ensureSpendPanel();
        this._renderSpendPanel();
        const panel = this._spendPanelEl;
        const rect = this.els.rateWrap.getBoundingClientRect();
        panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 516))}px`;
        panel.style.top = `${rect.bottom + 7}px`;
        panel.style.display = 'block';
        this.els.rateWrap.setAttribute('aria-expanded', 'true');
        focusWithoutScroll(panel);
    }

    _hideSpendPanel({ restoreFocus = true } = {}) {
        const wasOpen = this._spendPanelEl?.style.display !== 'none';
        if (this._spendPanelEl) this._spendPanelEl.style.display = 'none';
        this.els.rateWrap?.setAttribute('aria-expanded', 'false');
        if (restoreFocus && wasOpen) focusWithoutScroll(this.els.rateWrap);
    }

    _renderSpendPanel() {
        const panel = this._spendPanelEl;
        if (!panel) return;
        const rollups = this._spendRollups || { projects: [], providers: [] };
        const heading = el('div', {
            text: 'SPEND MAP',
            className: 'topbar__spend-heading',
        });
        const hasUnknownModel = [...(this.world?.agents?.values?.() || [])]
            .some((agent) => agent.cost?.unknownModel === true);
        const note = el('div', {
            className: 'topbar__spend-note',
            title: `Estimated API pricing · rate match: mixed session models · revision ${TokenUsage.rateRevision}`,
        }, [
            `5-minute burn rate first · today observed totals · estimated API pricing, revision ${TokenUsage.rateRevision}. ${this._coverageNote || ''}`,
            hasUnknownModel ? ' ' : null,
            hasUnknownModel ? el('span', { className: 'dash-card__provider-badge', text: 'default rate' }) : null,
        ]);
        const columns = el('div', {
            className: 'topbar__spend-columns',
        }, [
            this._spendSection('PROJECTS', rollups.projects, true),
            this._spendSection('PROVIDERS', rollups.providers, false),
        ]);
        replaceChildren(panel, [heading, note, columns]);
    }

    _spendSection(title, rows, projects) {
        const section = el('section', {
            className: `topbar__spend-section topbar__spend-section--${projects ? 'projects' : 'providers'}`,
        });
        section.appendChild(el('div', {
            text: title,
            className: 'topbar__spend-section-heading',
        }));

        const visible = (rows || []).slice(0, 5);
        const projectLabels = projects ? this._projectLabels(rows) : null;
        if (visible.length === 0) {
            section.appendChild(el('div', {
                text: 'No sessions observed',
                className: 'topbar__spend-empty',
            }));
            return section;
        }

        for (const row of visible) {
            const name = projects
                ? projectLabels.get(row.key)
                : this._providerLabel(row.key);
            const burning = row.burnRate && row.burnRate.tokensPerHour > 0;
            const activeNoSpend = row.activeSessions > 0 && row.tokens === 0 && row.cost === 0;
            const unknownRate = [...(this.world?.agents?.values?.() || [])].some((agent) => {
                const key = projects
                    ? String(agent.projectPath || '').trim() || 'unattributed'
                    : String(agent.provider || '').trim().toLowerCase() || 'unknown';
                return key === row.key && agent.cost?.unknownModel === true;
            });
            const primary = burning
                ? `${formatNumber(Math.round(row.burnRate.tokensPerHour))}/h · ~${formatCost(row.burnRate.costPerHour)}/h`
                : activeNoSpend ? 'WATCHING · no spend observed' : 'QUIET';
            const detail = `${formatNumber(row.tokens)} tokens · ~${formatCost(row.cost)}`;
            section.appendChild(el('div', {
                title: `${projects ? row.key : `${name} provider`} · estimated API rates · rate match: mixed session models · revision ${TokenUsage.rateRevision}`,
                className: 'topbar__spend-row',
            }, [
                el('div', {
                    text: `${row.activeSessions > 0 ? '◆' : '·'} ${name}`,
                    className: `topbar__spend-name${row.activeSessions > 0 ? ' topbar__spend-name--active' : ''}`,
                }),
                el('div', {}, [
                    el('div', {
                        text: primary,
                        className: `topbar__spend-primary${burning ? ' topbar__spend-primary--burning' : ''}`,
                    }),
                    el('div', {
                        text: detail,
                        className: 'topbar__spend-detail',
                    }),
                    unknownRate ? ' ' : null,
                    unknownRate ? el('span', { className: 'dash-card__provider-badge', text: 'default rate' }) : null,
                ]),
            ]));
        }
        if (rows.length > visible.length) {
            section.appendChild(el('div', {
                text: `+${rows.length - visible.length} quieter ${projects ? 'projects' : 'providers'}`,
                className: 'topbar__spend-more',
            }));
        }
        return section;
    }

    _projectLabels(rows) {
        const names = new Map();
        const counts = new Map();
        for (const row of rows || []) {
            const name = row.key === 'unattributed' ? 'Unattributed' : shortProjectName(row.key, 'Unattributed');
            names.set(row.key, name);
            counts.set(name, (counts.get(name) || 0) + 1);
        }
        for (const row of rows || []) {
            const name = names.get(row.key);
            if ((counts.get(name) || 0) < 2 || row.key === 'unattributed') continue;
            const parts = String(row.key).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
            names.set(row.key, parts.slice(-2).join('/'));
        }
        return names;
    }

    _providerLabel(provider) {
        const labels = {
            claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok',
            kimi: 'Kimi', opencode: 'OpenCode', omp: 'OMP', unknown: 'Unknown',
        };
        return labels[provider] || String(provider || 'Unknown');
    }

    // Quota is the resource that actually runs out on a subscription, so it
    // gets the bars and the dollar figure is labelled an estimate.
    _renderQuota() {
        const quota = this._usage?.quota;
        const wrap = this.els.quotaWrap;
        if (!wrap) return;
        const fiveHour = Number(quota?.fiveHour);
        const sevenDay = Number(quota?.sevenDay);
        const hasFiveHourUsage = Number.isFinite(fiveHour) && fiveHour > 0;
        const hasSevenDayUsage = Number.isFinite(sevenDay) && sevenDay > 0;
        if (!hasFiveHourUsage && !hasSevenDayUsage) {
            wrap.hidden = true;
            return;
        }
        wrap.hidden = false;
        const pct = (value) => Math.round(Math.max(0, Math.min(1, value || 0)) * 100);
        const five = pct(fiveHour);
        const seven = pct(sevenDay);
        if (this.els.quota5h) this.els.quota5h.style.width = `${five}%`;
        if (this.els.quota7d) this.els.quota7d.style.width = `${seven}%`;
        const windows = [];
        if (hasFiveHourUsage) windows.push(`5h ${five}%`);
        if (hasSevenDayUsage) windows.push(`7d ${seven}%`);
        if (this.els.quotaText) this.els.quotaText.textContent = windows.join(' · ');
        wrap.title = `Claude usage: ${windows.join(', ')}`;
        // Near the ceiling the bars stop being scenery.
        const hot = Math.max(fiveHour || 0, sevenDay || 0) > 0.85;
        wrap.classList.toggle('topbar__quota-meta--hot', hot);
    }

    // Living activity rail: a 2px strip along the topbar bottom whose hue and
    // intensity echo the fleet's status mix. Mostly-working reads as a warm
    // gold; any errored agent bleeds red in from the left, weighted by how much
    // of the fleet is failing. Driven by CSS custom props the rail strip reads.
    _renderActivityRail(stats) {
        if (!this.els.root) return;
        const total = stats.total || 0;
        const erroredRatio = total > 0 ? stats.errored / total : 0;
        const activeRatio = total > 0 ? (stats.working + stats.waiting) / total : 0;

        // Hue: 45deg warm gold by default, pulled toward 8deg red as the
        // errored fraction climbs. Alpha rises with both trouble and activity
        // so an idle/empty village rests dim.
        const hue = Math.round(45 - 37 * erroredRatio);
        const alpha = (0.18 + 0.42 * activeRatio + 0.4 * erroredRatio).toFixed(3);
        // Red bleed origin: 100% (offscreen right) when calm, sliding left as
        // more agents error so the red enters from the left edge.
        const bleed = Math.round(100 - 100 * erroredRatio);

        const style = this.els.root.style;
        style.setProperty('--cv-rail-hue', `${hue}`);
        style.setProperty('--cv-rail-alpha', `${alpha}`);
        style.setProperty('--cv-rail-bleed', `${bleed}%`);
    }

    _initConnectionInstrument() {
        const chip = this.els.connection;
        if (!chip) return;
        chip.tabIndex = 0;
        chip.setAttribute('role', 'button');
        chip.setAttribute('aria-haspopup', 'dialog');
        chip.setAttribute('aria-controls', 'topbarConnectionDetails');
        chip.setAttribute('aria-expanded', 'false');
        chip.title = 'Connection details';
        this._connectionLiveEl = el('span', {
            className: 'topbar__connection-live',
        });
        this._connectionLiveEl.setAttribute('aria-live', 'polite');
        chip.insertAdjacentElement('afterend', this._connectionLiveEl);
        this._onConnectionClick = (event) => {
            event.stopPropagation();
            this._toggleConnectionDetails();
        };
        this._onConnectionEnter = () => this._showConnectionDetails({ focus: false });
        this._onConnectionLeave = (event) => {
            if (this._connectionPanelEl?.contains(event.relatedTarget)) return;
            this._hideConnectionDetails({ restoreFocus: false });
        };
        this._onConnectionKeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this._hideConnectionDetails();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this._toggleConnectionDetails();
            }
        };
        this._onConnectionOutside = (event) => {
            if (this._connectionPanelEl?.contains(event.target) || chip.contains(event.target)) return;
            this._hideConnectionDetails({ restoreFocus: false });
        };
        chip.addEventListener('click', this._onConnectionClick);
        chip.addEventListener('mouseenter', this._onConnectionEnter);
        chip.addEventListener('mouseleave', this._onConnectionLeave);
        chip.addEventListener('keydown', this._onConnectionKeydown);
        document.addEventListener('pointerdown', this._onConnectionOutside);
        this._renderConnection();
    }

    _renderConnection(now = Date.now()) {
        const chip = this.els.connection;
        if (!chip) return;
        const label = linkStatusText(this._villageState, now);
        const stale = isStale(this._villageState, now);
        const state = stale ? LinkState.STALE
            : this._villageState.source === 'simulator' ? LinkState.LIVE : this._villageState.link.state;
        chip.textContent = label;
        chip.classList.toggle('topbar__conn--connected', state === LinkState.LIVE);
        chip.classList.toggle('topbar__conn--disconnected', state === LinkState.RECONNECTING);
        chip.classList.toggle('topbar__conn--syncing', state === LinkState.SYNCING);
        chip.classList.toggle('topbar__conn--polling', state === LinkState.POLLING);
        chip.classList.toggle('topbar__conn--reconnecting', state === LinkState.RECONNECTING);
        chip.classList.toggle('topbar__conn--stale', stale);
        const announcementKey = stale ? LinkState.STALE : state;
        if (announcementKey !== this._connectionAnnouncementKey) {
            this._connectionAnnouncementKey = announcementKey;
            if (this._connectionLiveEl) this._connectionLiveEl.textContent = `Connection ${label}`;
        }
        this._renderConnectionDetails(now);
        if (stale) this._scheduleStaleTick();
        else this._stopStaleTick();
    }

    _scheduleStaleTick() {
        if (this._staleTimer || this._destroyed) return;
        this._staleTimer = setTimeout(() => {
            this._staleTimer = null;
            if (!this._destroyed && isStale(this._villageState)) this._renderConnection();
        }, 1000);
    }

    _stopStaleTick() {
        if (!this._staleTimer) return;
        clearTimeout(this._staleTimer);
        this._staleTimer = null;
    }

    _ensureConnectionDetails() {
        if (this._connectionPanelEl || !document.body) return;
        this._connectionPanelEl = el('div', {
            className: 'topbar__connection-panel',
            ariaLabel: 'Connection details',
            style: { display: 'none' },
        });
        this._connectionPanelEl.id = 'topbarConnectionDetails';
        this._connectionPanelEl.setAttribute('role', 'dialog');
        this._connectionPanelEl.tabIndex = -1;
        this._connectionPanelEl.addEventListener('keydown', this._onConnectionKeydown);
        this._onConnectionPanelLeave = (event) => {
            if (this.els.connection?.contains(event.relatedTarget)) return;
            this._hideConnectionDetails({ restoreFocus: false });
        };
        this._connectionPanelEl.addEventListener('mouseleave', this._onConnectionPanelLeave);
        document.body.appendChild(this._connectionPanelEl);
    }

    _toggleConnectionDetails() {
        this._ensureConnectionDetails();
        if (this._connectionPanelEl?.style.display === 'none') this._showConnectionDetails();
        else this._hideConnectionDetails();
    }

    _showConnectionDetails({ focus = true } = {}) {
        if (this._destroyed || !this.els.connection) return;
        this._ensureConnectionDetails();
        const panel = this._connectionPanelEl;
        if (!panel) return;
        this._renderConnectionDetails();
        const rect = this.els.connection.getBoundingClientRect();
        panel.style.left = `${Math.max(8, rect.left)}px`;
        panel.style.top = `${rect.bottom}px`;
        panel.style.display = 'grid';
        this.els.connection.setAttribute('aria-expanded', 'true');
        if (focus) focusWithoutScroll(panel);
    }

    _hideConnectionDetails({ restoreFocus = true } = {}) {
        const wasOpen = this._connectionPanelEl?.style.display !== 'none';
        if (this._connectionPanelEl) this._connectionPanelEl.style.display = 'none';
        this.els.connection?.setAttribute('aria-expanded', 'false');
        if (restoreFocus && wasOpen) focusWithoutScroll(this.els.connection);
    }

    _renderConnectionDetails(now = Date.now()) {
        const panel = this._connectionPanelEl;
        if (!panel) return;
        const link = this._villageState.link;
        const age = snapshotAgeMs(this._villageState, now);
        const snapshot = age === null
            ? 'Last successful snapshot: not received yet'
            : `Last successful snapshot: ${Math.round(age / 1000)}s ago`;
        const rows = [el('div', { text: snapshot })];
        if (link.state === LinkState.RECONNECTING && link.nextRetryAt) {
            const retryMs = Math.max(0, link.nextRetryAt - now);
            rows.push(el('div', { text: `Next retry: in ${Math.ceil(retryMs / 1000)}s` }));
        }
        const code = link.lastErrorCode || this._villageState.failureCode;
        if (code) rows.push(el('div', { text: `Reason: ${connectionReasonText(code)}` }));
        replaceChildren(panel, rows);
    }

    // Connection-loss as a felt chrome event: while offline the whole app
    // desaturates and dashboard cards freeze to a muted, shimmering opacity.
    // On reconnect a single warm gold sweep washes color back across the
    // chrome. The sweep waits for a new successful snapshot and its class is
    // cleared by a fallback timer, including when reduced motion is enabled.
    _applyConnectionChrome(connected) {
        const body = document.body;
        if (!body) return;
        if (!connected && !this._recoverySweepPending) {
            this._recoverySweepPending = true;
            this._recoveryBaselineSnapshotAt = this._villageState.link.lastSnapshotAt;
        }
        body.classList.toggle('cv-offline', !connected);
        const snapshotAt = this._villageState.link.lastSnapshotAt;
        if (connected
            && this._recoverySweepPending
            && snapshotAt
            && snapshotAt !== this._recoveryBaselineSnapshotAt
            && snapshotAt !== this._lastSweptSnapshotAt) {
            this._recoverySweepPending = false;
            this._recoveryBaselineSnapshotAt = snapshotAt;
            this._lastSweptSnapshotAt = snapshotAt;
            this._fireRecoverySweep(body);
        }
    }

    _fireRecoverySweep(body) {
        if (this._sweepTimer) clearTimeout(this._sweepTimer);
        body.classList.remove('cv-reconnect-sweep');
        // Force reflow so re-adding the class restarts the animation.
        void body.offsetWidth;
        body.classList.add('cv-reconnect-sweep');
        this._sweepTimer = setTimeout(() => {
            body.classList.remove('cv-reconnect-sweep');
            this._sweepTimer = null;
        }, 1100);
    }

    // The top bar no longer carries an FPS read-out (the witness clock owns that
    // slot); this only keeps the last honest sample for Settings > Health, which
    // must be able to tell a suspended render loop (null) from a genuine 0 FPS.
    renderFps(fps) {
        this._lastFps = typeof fps === 'number' && Number.isFinite(fps) ? fps : null;
    }

    _startTimer() {
        this.timeInterval = setInterval(() => {
            const seconds = this.world.activeTime;
            const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
            const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
            const s = String(seconds % 60).padStart(2, '0');
            if (this.els.time) this.els.time.textContent = `${h}:${m}:${s}`;
        }, 1000);
    }

    async _openChangelog() {
        if (!this.modal || this._destroyed) return;
        const request = this.modal.beginRequest();
        if (request === null) return;
        if (!this._changelogHtml) {
            this._changelogController?.abort?.();
            const controller = new AbortController();
            this._changelogController = controller;
            try {
                const res = await fetch('/api/changelog', { signal: controller.signal });
                if (!res.ok) throw new Error(res.statusText);
                this._changelogHtml = this._changelogToHtml(await res.text());
            } catch (err) {
                if (err?.name === 'AbortError') return;
                this._changelogHtml = '<p>Failed to load changelog.</p>';
            } finally {
                if (this._changelogController === controller) this._changelogController = null;
            }
        }
        if (this._destroyed || !this.modal.isRequestCurrent(request)) return;
        this.modal.open('Changelog', this._changelogHtml, { wide: true, request });
    }

    _changelogToHtml(md) {
        const lines = md.split('\n');
        const parts = [];
        let inList = false;

        const closeList = () => {
            if (inList) { parts.push('</ul>'); inList = false; }
        };

        for (const line of lines) {
            if (line.startsWith('# ') || line === '---') {
                closeList();
            } else if (line.startsWith('## ')) {
                closeList();
                const text = line.slice(3).trim();
                const hotfixM = text.match(/^(v[\d.]+)\s+·\s+(.+?)\s+—\s+Hotfix/);
                const namedM  = text.match(/^(v[\d.]+)\s+—\s+\*(.+?)\*\s+·\s+(.+)/);
                if (namedM) {
                    const [, ver, name, date] = namedM;
                    parts.push(
                        `<div class="cl-release">` +
                        `<span class="cl-ver">${ver}</span>` +
                        `<span class="cl-name">${name}</span>` +
                        `<span class="cl-date">${date}</span>` +
                        `</div>`
                    );
                } else if (hotfixM) {
                    const [, ver, date] = hotfixM;
                    parts.push(
                        `<div class="cl-release cl-release--hotfix">` +
                        `<span class="cl-ver">${ver}</span>` +
                        `<span class="cl-hotfix-badge">Hotfix</span>` +
                        `<span class="cl-date">${date}</span>` +
                        `</div>`
                    );
                }
            } else if (line.startsWith('- ')) {
                if (!inList) { parts.push('<ul class="cl-list">'); inList = true; }
                parts.push(`<li>${this._inline(line.slice(2))}</li>`);
            } else if (line.trim() === '') {
                closeList();
            } else {
                closeList();
                parts.push(`<p>${this._inline(line)}</p>`);
            }
        }
        closeList();
        return parts.join('');
    }

    _inline(text) {
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>');
    }

    destroy() {
        if (this._destroyed) return this._destroyPromise;
        this._destroyed = true;
        eventBus.off('atmosphere:updated', this._onAtmosphere);
        this.els.needsYou?.remove();
        if (this.timeInterval) {
            clearInterval(this.timeInterval);
            this.timeInterval = null;
        }
        if (this._sweepTimer) {
            clearTimeout(this._sweepTimer);
            this._sweepTimer = null;
        }
        this._stopStaleTick();
        this._changelogController?.abort?.();
        this._changelogController = null;
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
        eventBus.off('fps:updated', this._onFps);
        eventBus.off('usage:updated', this._onUsage);
        eventBus.off('village:state', this._onVillageState);
        eventBus.off('chronicle:status', this._onChronicleStatus);
        if (this.els.connection) {
            this.els.connection.removeEventListener('click', this._onConnectionClick);
            this.els.connection.removeEventListener('mouseenter', this._onConnectionEnter);
            this.els.connection.removeEventListener('mouseleave', this._onConnectionLeave);
            this.els.connection.removeEventListener('keydown', this._onConnectionKeydown);
        }
        if (this._onConnectionOutside) document.removeEventListener('pointerdown', this._onConnectionOutside);
        if (this._connectionPanelEl && this._onConnectionPanelLeave) {
            this._connectionPanelEl.removeEventListener('mouseleave', this._onConnectionPanelLeave);
        }
        this._connectionPanelEl?.remove();
        this._connectionLiveEl?.remove();
        this._connectionPanelEl = null;
        this._connectionLiveEl = null;
        if (this._onAutoCamera) eventBus.off('camera:auto-camera', this._onAutoCamera);
        if (this._onCinemaClick && this.els.cinemaToggle) {
            this.els.cinemaToggle.removeEventListener('click', this._onCinemaClick);
        }
        if (this._onVersionClick && this.els.version) {
            this.els.version.removeEventListener('click', this._onVersionClick);
        }
        if (this._onVersionKeydown && this.els.version) {
            this.els.version.removeEventListener('keydown', this._onVersionKeydown);
        }
        if (this._onAlertsClick && this.els.alertsToggle) {
            this.els.alertsToggle.removeEventListener('click', this._onAlertsClick);
        }
        if (this._onAttentionKey) document.removeEventListener('keydown', this._onAttentionKey);
        if (this._onChronicleClick && this.els.chronicleBtn) {
            this.els.chronicleBtn.removeEventListener('click', this._onChronicleClick);
        }
        if (this._onSettingsClick && this._settingsButtonEl) {
            this._settingsButtonEl.removeEventListener('click', this._onSettingsClick);
        }
        this._settingsButtonEl?.remove();
        this._settingsButtonEl = null;
        this._settingsPanel?.destroy();
        this._settingsPanel = null;
        if (this._onSpendClick && this.els.rateWrap) {
            this.els.rateWrap.removeEventListener('click', this._onSpendClick);
            this.els.rateWrap.removeEventListener('keydown', this._onSpendKeydown);
            this.els.rateWrap.removeEventListener('focusout', this._onSpendFocusOut);
        }
        if (this._onSpendOutside) document.removeEventListener('pointerdown', this._onSpendOutside);
        if (this._onSpendResize) window.removeEventListener('resize', this._onSpendResize);
        if (this._spendPanelEl && this._onSpendPanelKeydown) {
            this._spendPanelEl.removeEventListener('keydown', this._onSpendPanelKeydown);
        }
        if (this._spendPanelEl && this._onSpendFocusOut) {
            this._spendPanelEl.removeEventListener('focusout', this._onSpendFocusOut);
        }
        this._spendPanelEl?.remove();
        this._spendPanelEl = null;
        if (this._onMixerClick && this._mixerButtonEl) {
            this._mixerButtonEl.removeEventListener('click', this._onMixerClick);
            this._mixerButtonEl.removeEventListener('keydown', this._onMixerKeydown);
            this._mixerButtonEl.removeEventListener('focusout', this._onMixerFocusOut);
        }
        if (this._onMixerPanelKeydown && this._mixerPanelEl) {
            this._mixerPanelEl.removeEventListener('keydown', this._onMixerPanelKeydown);
        }
        if (this._onMixerFocusOut && this._mixerPanelEl) {
            this._mixerPanelEl.removeEventListener('focusout', this._onMixerFocusOut);
        }
        if (this._onMixerOutside) document.removeEventListener('pointerdown', this._onMixerOutside);
        if (this._onMixerResize) window.removeEventListener('resize', this._onMixerResize);
        this._mixerButtonEl?.remove();
        this._mixerPanelEl?.remove();
        this._mixerButtonEl = null;
        this._mixerPanelEl = null;
        this.chronicle?.destroy?.();
        this.chronicle = null;
        if (this._onDeferredAudioClick) {
            this.els.soundToggle?.removeEventListener('click', this._onDeferredAudioClick);
            this._onDeferredAudioClick = null;
        }
        this._audioOptions = null;
        document.body?.classList.remove('cv-offline', 'cv-reconnect-sweep');
        this._destroyPromise = Promise.resolve(this.audio?.destroy?.());
        this.audio = null;
        return this._destroyPromise;
    }
}
