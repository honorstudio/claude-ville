// Facade between the top-bar sound controls and the audio system. Owns the
// opt-in lifecycle — off by default, user-gesture unlock, tab-hidden suspend,
// localStorage persistence — and delegates all sound to AudioEngine (mix
// chain) and AudioDirector (world-reactive layers and cues) in ./audio/.

import { AudioEngine, clamp01 } from './audio/AudioEngine.js';
import { AudioDirector } from './audio/AudioDirector.js';
import {
    BgmDirector,
    workingSectionCounts,
    workingSectionLabel,
} from './audio/BgmDirector.js';
import { eventBus } from '../../domain/events/DomainEvent.js';

const STORAGE_KEY = 'claudeville.sound.enabled';
const VOLUME_KEY = 'claudeville.sound.volume';
const MODE_KEY = 'claudeville.sound.mode';
const LAYER_LEVELS_KEY = 'claudeville.sound.layers';
const DEFAULT_VOLUME = 0.5;
const MODES = ['ambient', 'bgm'];
const HIDDEN_SUMMONS_HOLD_MS = 3200;
// Agent updates arrive in bursts; one coalesced read per burst keeps the label
// within a beat of the world, and it is written only when its counts actually
// change, so a busy poll never touches the DOM.
const SECTION_LABEL_COALESCE_MS = 150;

export const AUDIO_MIXER_DEFAULTS = Object.freeze({
    wind: 1,
    rain: 1,
    wildlife: 1,
    hum: 1,
    music: 1,
});

function readStoredPreference() {
    try {
        return window.localStorage?.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function writeStoredPreference(enabled) {
    try {
        window.localStorage?.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Preference persistence is optional.
    }
}

function readStoredVolume() {
    try {
        const raw = window.localStorage?.getItem(VOLUME_KEY);
        if (raw == null) return DEFAULT_VOLUME;
        return clamp01(Number(raw), DEFAULT_VOLUME);
    } catch {
        return DEFAULT_VOLUME;
    }
}

function writeStoredVolume(volume) {
    try {
        window.localStorage?.setItem(VOLUME_KEY, String(volume));
    } catch {
        // Preference persistence is optional.
    }
}

function readStoredMode() {
    try {
        const raw = window.localStorage?.getItem(MODE_KEY);
        return MODES.includes(raw) ? raw : 'ambient';
    } catch {
        return 'ambient';
    }
}

function writeStoredMode(mode) {
    try {
        window.localStorage?.setItem(MODE_KEY, mode);
    } catch {
        // Preference persistence is optional.
    }
}

export function readStoredLayerLevels(storage = globalThis.window?.localStorage) {
    try {
        const parsed = JSON.parse(storage?.getItem(LAYER_LEVELS_KEY) || '{}');
        return Object.fromEntries(Object.entries(AUDIO_MIXER_DEFAULTS).map(([name, fallback]) => [
            name,
            clamp01(parsed?.[name], fallback),
        ]));
    } catch {
        return { ...AUDIO_MIXER_DEFAULTS };
    }
}

function writeStoredLayerLevels(levels, storage = globalThis.window?.localStorage) {
    try {
        storage?.setItem(LAYER_LEVELS_KEY, JSON.stringify(levels));
    } catch {
        // Preference persistence is optional.
    }
}

export class AmbientAudioController {
    constructor({
        button,
        volumeSlider,
        modeButton,
        mixerButton,
        mixerPanel,
        layerControls,
        world,
    } = {}) {
        this.button = button || null;
        this.volumeSlider = volumeSlider || null;
        this.modeButton = modeButton || null;
        this.mixerButton = mixerButton || null;
        this.mixerPanel = mixerPanel || null;
        this.layerControls = layerControls || {};
        this.world = world || null;
        this.available = this._hasAudioSupport();
        this.enabled = readStoredPreference();
        this.volume = readStoredVolume();
        this.mode = readStoredMode();
        this.layerLevels = readStoredLayerLevels();
        this.userActivated = false;
        this.unlockArmed = false;
        this._activationGeneration = 0;
        this._visibilityGeneration = 0;
        this._suspendTimer = null;
        this._hiddenSummonsTimer = null;
        this._hiddenSummonsPending = new Set();
        this._layerBindings = new WeakMap();
        this._layerInputHandlers = new Map();
        this._destroyPromise = null;
        this._destroyed = false;
        this._windowBlurred = false;
        // The working-section label lives beside the music control; the topbar
        // markup owns the element, this controller owns its counts.
        this.sectionLabel = typeof document !== 'undefined'
            ? document.getElementById('topbarSoundSection')
            : null;
        this._sectionLabelText = '';
        this._sectionLabelTimer = null;

        this.engine = new AudioEngine();
        this.engine.setVolume(this.volume);
        this.directors = {
            ambient: new AudioDirector({ engine: this.engine, world: this.world }),
            bgm: new BgmDirector({ engine: this.engine, world: this.world }),
        };
        this.directors.ambient.setHiddenSummonsHandler?.((payload) => {
            this._handleHiddenSummons(payload);
        });
        this.directors.ambient.setHidden(
            typeof document !== 'undefined' && document.hidden,
        );
        this.directors.ambient.setSignalRouting(true);

        this._onButtonClick = () => this._handleToggle();
        this._onModeClick = () => this.setMode(this.mode === 'ambient' ? 'bgm' : 'ambient');
        this._onUnlockGesture = (event) => this._handleUnlockGesture(event);
        this._onVisibility = () => this._handleVisibility();
        this._onWindowBlur = () => this._handleWindowBlur();
        this._onWindowFocus = () => this._handleWindowFocus();
        this._onVolumeInput = (event) => {
            this.setVolume(Number(event?.target?.value) / 100);
        };

        if (this.button) this.button.addEventListener('click', this._onButtonClick);
        if (this.modeButton) this.modeButton.addEventListener('click', this._onModeClick);
        if (this.volumeSlider) this.volumeSlider.addEventListener('input', this._onVolumeInput);
        for (const [name, control] of Object.entries(this.layerControls)) {
            if (!Object.hasOwn(AUDIO_MIXER_DEFAULTS, name) || !control?.slider) continue;
            const handler = (event) => this.setLayerLevel(name, Number(event?.target?.value) / 100);
            this._layerInputHandlers.set(name, handler);
            control.slider.addEventListener('input', handler);
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('blur', this._onWindowBlur);
            window.addEventListener('focus', this._onWindowFocus);
        }
        this._onWorldCountsChanged = () => this._scheduleSectionLabel();
        for (const event of ['agent:added', 'agent:updated', 'agent:removed']) {
            eventBus.on(event, this._onWorldCountsChanged);
        }

        this._renderControls();
        if (this.enabled) this._armUnlockListeners();

        if (typeof window !== 'undefined') {
            this._debugHelper = () => this._debugSnapshot();
            window.__claudevilleAudio = this._debugHelper;
        }
    }

    _handleToggle() {
        this.userActivated = true;
        this.setEnabled(!this.enabled);
    }

    setEnabled(enabled) {
        if (!this.available || this._destroyed) return;

        this.enabled = Boolean(enabled);
        writeStoredPreference(this.enabled);
        this._renderControls();
        this._removeUnlockListeners();

        if (this.enabled) void this._activate();
        else this._deactivate();
    }

    setVolume(value) {
        this.volume = clamp01(value, DEFAULT_VOLUME);
        writeStoredVolume(this.volume);
        this.engine.setVolume(this.volume);
        if (this.volumeSlider) this.volumeSlider.value = String(Math.round(this.volume * 100));
    }

    setLayerLevel(name, value) {
        if (this._destroyed || !Object.hasOwn(AUDIO_MIXER_DEFAULTS, name)) return false;
        this.layerLevels[name] = clamp01(value, AUDIO_MIXER_DEFAULTS[name]);
        writeStoredLayerLevels(this.layerLevels);
        this._renderLayerControl(name);
        this._reapplyLayerMix(name);
        return true;
    }

    get director() {
        return this.directors[this.mode] || this.directors.ambient;
    }

    // Switch between the reactive ambience and continuous town BGM.
    setMode(mode) {
        if (this._destroyed || !MODES.includes(mode) || mode === this.mode) return;
        const wasRunning = this.director.running;
        if (wasRunning) {
            this.director.governor?.clearRoutine?.();
            this.director.stop();
        }
        this.mode = mode;
        writeStoredMode(mode);
        this._renderControls();
        if (wasRunning && !this._pageInactive()) {
            this.directors.ambient.setSignalRouting(this.mode !== 'bgm');
            this.director.start();
            this._installActiveLayerMix();
            this._syncSignalRouting();
        } else {
            // With no active BGM director, the ambient director is the
            // signal-only route for captions and disabled-sound cues.
            this.directors.ambient.setSignalRouting(true);
        }
    }

    async _activate() {
        if (!this.enabled || !this.available || this._destroyed || this._pageInactive()) return;
        if (this._suspendTimer) {
            clearTimeout(this._suspendTimer);
            this._suspendTimer = null;
        }
        if (this._hiddenSummonsTimer) {
            clearTimeout(this._hiddenSummonsTimer);
            this._hiddenSummonsTimer = null;
        }
        this.directors.ambient.setHidden(false);
        this.directors.ambient.setSignalRouting(this.mode !== 'bgm');
        const activationGeneration = ++this._activationGeneration;
        const visibilityGeneration = this._visibilityGeneration;
        let ready = false;
        try {
            ready = await this.engine.ensureContext();
        } catch {
            return;
        }
        if (
            !ready
            || !this.enabled
            || this._destroyed
            || this._pageInactive()
            || activationGeneration !== this._activationGeneration
            || visibilityGeneration !== this._visibilityGeneration
        ) {
            if (this._pageInactive()) await this.engine.suspend();
            return;
        }

        this.engine.start();
        this.director.start();
        this._installActiveLayerMix();
        this._syncSignalRouting();
    }

    // Scale each director's live target instead of pinning a fixed level. This
    // preserves weather/time-of-day slews while giving the listener a durable
    // trim. Instances are recreated on every mode switch/resume, so bindings
    // are installed immediately after each start.
    _installActiveLayerMix() {
        const ambient = this.directors.ambient;
        if (ambient.running) {
            this._bindLayerMix(ambient.layers.wind, 'wind');
            this._bindLayerMix(ambient.layers.rain, 'rain');
            this._bindLayerMix(ambient.layers.birds, 'wildlife');
            this._bindLayerMix(ambient.layers.crickets, 'wildlife');
            this._bindLayerMix(ambient.layers.hum, 'hum');
            this._bindLayerMix(ambient.layers.bed, 'music');
            this._bindLayerMix(ambient.layers.music, 'music');
        }
        if (this.directors.bgm.running) {
            this._bindLayerMix(this.directors.bgm.player, 'music');
        }
    }

    _bindLayerMix(layer, mixName) {
        if (!layer?.setLevel || this._layerBindings.has(layer)) return;
        const originalSetLevel = layer.setLevel.bind(layer);
        let liveTarget = clamp01(layer.level);
        const binding = {
            mixName,
            reapply: (timeConstant = 0.25) => originalSetLevel(
                liveTarget * this.layerLevels[mixName],
                timeConstant,
            ),
        };
        layer.setLevel = (value, timeConstant) => {
            liveTarget = clamp01(value);
            return originalSetLevel(liveTarget * this.layerLevels[mixName], timeConstant);
        };
        this._layerBindings.set(layer, binding);
        binding.reapply();
    }

    _reapplyLayerMix(name) {
        const candidates = [
            ...Object.values(this.directors.ambient.layers || {}),
            this.directors.bgm.player,
        ];
        for (const layer of candidates) {
            const binding = layer && this._layerBindings.get(layer);
            if (binding?.mixName === name) binding.reapply();
        }
    }

    _deactivate({ forceSuspend = false, visibilityGeneration = this._visibilityGeneration } = {}) {
        this._activationGeneration++;
        for (const director of Object.values(this.directors)) {
            director.governor?.clearRoutine?.();
            director.stop();
        }
        this.directors.ambient.setSignalRouting(true);
        this.engine.stop();
        if (this._suspendTimer) clearTimeout(this._suspendTimer);
        this._suspendTimer = setTimeout(() => {
            this._suspendTimer = null;
            if (this._destroyed) return;
            const hiddenGenerationMatches = (
                forceSuspend
                && this._pageInactive()
                && visibilityGeneration === this._visibilityGeneration
            );
            if (!this.enabled || hiddenGenerationMatches) void this.engine.suspend();
        }, 800);
    }

    _handleUnlockGesture(event) {
        if (!this.enabled || this.userActivated) return;
        if (this.button && event?.target && this.button.contains(event.target)) return;

        this.userActivated = true;
        this._removeUnlockListeners();
        void this._activate();
    }

    _handleVisibility() {
        if (typeof document === 'undefined') return;
        const visibilityGeneration = ++this._visibilityGeneration;
        if (document.hidden) {
            this.directors.ambient.setHidden(true);
            this._deactivate({ forceSuspend: true, visibilityGeneration });
        } else if (!this._windowBlurred && this.enabled && this.userActivated) {
            this.directors.ambient.setHidden(false);
            void this._activate();
        } else if (!this._windowBlurred) {
            this.directors.ambient.setHidden(false);
            this.directors.ambient.setSignalRouting(true);
        }
    }

    _handleWindowBlur() {
        if (this._destroyed || this._windowBlurred) return;
        this._windowBlurred = true;
        const visibilityGeneration = ++this._visibilityGeneration;
        this.directors.ambient.setHidden(true);
        this._deactivate({ forceSuspend: true, visibilityGeneration });
    }

    _handleWindowFocus() {
        if (this._destroyed || !this._windowBlurred) return;
        this._windowBlurred = false;
        ++this._visibilityGeneration;
        if (typeof document !== 'undefined' && document.hidden) return;
        this.directors.ambient.setHidden(false);
        if (this.enabled && this.userActivated) void this._activate();
        else this.directors.ambient.setSignalRouting(true);
    }

    _pageInactive() {
        return this._windowBlurred
            || (typeof document !== 'undefined' && document.hidden);
    }

    _syncSignalRouting() {
        const hidden = this._pageInactive();
        const bgmOwnsSignals = this.enabled && !hidden && this.mode === 'bgm' && this.directors.bgm.running;
        this.directors.ambient.setSignalRouting(!bgmOwnsSignals);
    }

    _handleHiddenSummons(payload) {
        if (this._destroyed) return;
        const agentId = payload?.agentId ?? payload?.agent?.id ?? '__anonymous__';
        if (this._hiddenSummonsPending.has(agentId)) return;
        this._hiddenSummonsPending.add(agentId);

        const generation = this._visibilityGeneration;
        const finish = () => this._hiddenSummonsPending.delete(agentId);
        if (!this.enabled || !this.available || !this.userActivated) {
            this._playHiddenUrgent(payload);
            finish();
            return;
        }

        if (this._suspendTimer) {
            clearTimeout(this._suspendTimer);
            this._suspendTimer = null;
        }

        void (async () => {
            let ready = false;
            try {
                ready = await this.engine.ensureContext();
            } catch {
                ready = false;
            }

            if (this._destroyed) {
                finish();
                return;
            }
            if (generation !== this._visibilityGeneration) {
                // The event still deserves an accessibility caption if the
                // user returned while resume was in flight.
                this._playHiddenUrgent(payload);
                finish();
                return;
            }
            if (!ready) {
                this._playHiddenUrgent(payload);
                finish();
                return;
            }

            this.engine.start();
            this._playHiddenUrgent(payload);
            this._scheduleHiddenSummonsSuspend(generation);
            finish();
        })();
    }

    _scheduleHiddenSummonsSuspend(generation) {
        if (this._hiddenSummonsTimer) clearTimeout(this._hiddenSummonsTimer);
        this._hiddenSummonsTimer = setTimeout(() => {
            this._hiddenSummonsTimer = null;
            if (
                this._destroyed
                || typeof document === 'undefined'
                || !this._pageInactive()
                || generation !== this._visibilityGeneration
            ) return;
            this.engine.stop();
            void this.engine.suspend();
        }, HIDDEN_SUMMONS_HOLD_MS);
    }

    _playHiddenUrgent(payload) {
        if (payload?.audioCueKind === 'distress') {
            return this.directors.ambient.cue('distress', payload);
        }
        return this.directors.ambient.playSummons(payload);
    }

    _armUnlockListeners() {
        if (!this.enabled || this.userActivated || this.unlockArmed || !this.available) return;
        document.addEventListener('pointerdown', this._onUnlockGesture, true);
        document.addEventListener('keydown', this._onUnlockGesture, true);
        this.unlockArmed = true;
    }

    _removeUnlockListeners() {
        if (!this.unlockArmed) return;
        document.removeEventListener('pointerdown', this._onUnlockGesture, true);
        document.removeEventListener('keydown', this._onUnlockGesture, true);
        this.unlockArmed = false;
    }

    _renderControls() {
        if (this.button) {
            this.button.disabled = !this.available;
            this.button.title = this.available
                ? (this.enabled ? 'Disable sound' : 'Enable sound')
                : 'Sound unavailable';
            this.button.setAttribute('aria-pressed', this.enabled && this.available ? 'true' : 'false');
            this.button.classList.toggle('topbar__sound-btn--on', this.enabled && this.available);
        }
        if (this.volumeSlider) {
            this.volumeSlider.hidden = !(this.enabled && this.available);
            this.volumeSlider.value = String(Math.round(this.volume * 100));
            this.volumeSlider.title = 'Master sound volume';
            this.volumeSlider.setAttribute('aria-label', 'Master sound volume');
        }
        if (this.modeButton) {
            this.modeButton.hidden = !(this.enabled && this.available);
            const bgm = this.mode === 'bgm';
            this.modeButton.textContent = bgm ? 'BGM' : 'AMBIENT';
            this.modeButton.title = bgm
                ? 'Town music mode — click for reactive ambience'
                : 'Reactive ambience mode — click for continuous town music';
            this.modeButton.setAttribute('aria-pressed', bgm ? 'true' : 'false');
            this.modeButton.classList.toggle('topbar__sound-btn--on', bgm);
        }
        if (this.mixerButton) {
            const shown = this.enabled && this.available;
            this.mixerButton.hidden = !shown;
            this.mixerButton.disabled = !this.available;
            if (!shown && this.mixerPanel) {
                this.mixerPanel.style.display = 'none';
                this.mixerButton.setAttribute('aria-expanded', 'false');
                this.mixerButton.classList.remove('topbar__sound-btn--on');
            }
        }
        for (const name of Object.keys(AUDIO_MIXER_DEFAULTS)) this._renderLayerControl(name);
        this._renderSectionLabel();
    }

    _scheduleSectionLabel() {
        if (this._destroyed || this._sectionLabelTimer) return;
        this._sectionLabelTimer = setTimeout(() => {
            this._sectionLabelTimer = null;
            this._renderSectionLabel();
        }, SECTION_LABEL_COALESCE_MS);
    }

    // `Working 7 · Waiting 2` — the counts the arrangement follows, written
    // only when they change. The music is never the only place they appear.
    _renderSectionLabel() {
        const label = this.sectionLabel;
        if (!label) return;
        const shown = this.enabled && this.available;
        label.hidden = !shown;
        if (!shown) return;
        const counts = workingSectionCounts(this.world);
        const text = workingSectionLabel(counts);
        if (text === this._sectionLabelText) return;
        this._sectionLabelText = text;
        label.textContent = text;
        label.title = `${counts.working} working · ${counts.needsYou} waiting on you`
            + ` · ${counts.watchlist} waiting on work`;
    }

    _renderLayerControl(name) {
        const control = this.layerControls[name];
        if (!control) return;
        const percent = Math.round(this.layerLevels[name] * 100);
        if (control.slider) {
            control.slider.value = String(percent);
            control.slider.setAttribute('aria-valuetext', `${percent}%`);
        }
        if (control.value) control.value.textContent = `${percent}%`;
    }

    _hasAudioSupport() {
        return Boolean(window.AudioContext || window.webkitAudioContext);
    }

    // Debug/QA surface: state readout plus handles to force layer levels,
    // fire cues, and set volume from the console or a headless browser.
    _debugSnapshot() {
        return {
            enabled: this.enabled,
            userActivated: this.userActivated,
            available: this.available,
            contextState: this.engine.context?.state || null,
            running: this.director.running,
            volume: this.volume,
            layerLevels: { ...this.layerLevels },
            rms: this.engine.rms(),
            mode: this.mode,
            sectionLabel: this._sectionLabelText,
            sectionCounts: workingSectionCounts(this.world),
            ...this.director.snapshot(),
            setVolume: (v) => this.setVolume(v),
            setLayerLevel: (name, level) => this.setLayerLevel(name, level),
            setMode: (m) => this.setMode(m),
            setLayer: (name, level, holdMs) => this.director.forceLayer?.(name, level, holdMs) ?? false,
            cue: (kind) => this.director.cue(kind),
        };
    }

    destroy() {
        if (this._destroyPromise) return this._destroyPromise;
        this._destroyed = true;
        this._activationGeneration++;
        this._visibilityGeneration++;
        this._removeUnlockListeners();
        for (const director of Object.values(this.directors)) {
            director.governor?.clearRoutine?.();
            director.stop();
        }
        if (this._suspendTimer) {
            clearTimeout(this._suspendTimer);
            this._suspendTimer = null;
        }
        if (this._hiddenSummonsTimer) {
            clearTimeout(this._hiddenSummonsTimer);
            this._hiddenSummonsTimer = null;
        }
        this._hiddenSummonsPending.clear();
        clearTimeout(this._sectionLabelTimer);
        this._sectionLabelTimer = null;
        for (const event of ['agent:added', 'agent:updated', 'agent:removed']) {
            eventBus.off(event, this._onWorldCountsChanged);
        }
        this.directors.ambient.destroy?.();

        if (this.button) this.button.removeEventListener('click', this._onButtonClick);
        if (this.modeButton) this.modeButton.removeEventListener('click', this._onModeClick);
        if (this.volumeSlider) this.volumeSlider.removeEventListener('input', this._onVolumeInput);
        for (const [name, handler] of this._layerInputHandlers) {
            this.layerControls[name]?.slider?.removeEventListener('input', handler);
        }
        this._layerInputHandlers.clear();
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('blur', this._onWindowBlur);
            window.removeEventListener('focus', this._onWindowFocus);
        }

        if (typeof window !== 'undefined' && window.__claudevilleAudio === this._debugHelper) {
            delete window.__claudevilleAudio;
        }
        this._destroyPromise = Promise.resolve(this.engine.dispose());
        return this._destroyPromise;
    }
}
