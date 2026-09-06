// Web Audio context lifecycle and master mix chain for the village soundscape.
//
// Graph:
//   ambienceBus → duckGain ─┐
//   cueBus ─────────────────┴→ mixBus → masterGain(volume²) → tone → limiter → analyser → destination
//
// Continuous layers connect to `ambienceBus`; one-shot cues connect to
// `cueBus`, which bypasses the duck so cues briefly sit above the ambience.
// `fade` rides on mixBus for enable/disable transitions. The limiter is a
// safety net only — target levels are mixed to never engage it audibly.

export const MIN_GAIN = 0.0001;

export function clamp01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

export function rand(min, max) {
    return min + Math.random() * (max - min);
}

export function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function buildNoiseBuffer(ctx, type, seconds = 4) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    if (type === 'brown') {
        let last = 0;
        for (let i = 0; i < length; i++) {
            const white = Math.random() * 2 - 1;
            last = (last + 0.02 * white) / 1.02;
            data[i] = last * 3.2;
        }
    } else {
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.6;
        }
    }
    return buffer;
}

export class AudioEngine {
    constructor() {
        this.context = null;
        this.ambienceBus = null;
        this.cueBus = null;
        this.duckGain = null;
        this.mixBus = null;
        this.fadeGain = null;
        this.masterGain = null;
        this.analyser = null;
        this.volume = 0.5;
        this.started = false;
        this._noiseBuffers = new Map();
        this._analyserData = null;
        this._disposed = false;
        this._disposePromise = null;
    }

    get running() {
        return Boolean(this.context && this.context.state === 'running');
    }

    now() {
        return this.context ? this.context.currentTime : 0;
    }

    async ensureContext() {
        if (this._disposed) return false;
        if (!this.context) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return false;
            this.context = new Ctor();
            this._buildGraph();
        }
        const context = this.context;
        if (context.state === 'suspended') {
            try { await context.resume(); } catch { /* needs a user gesture */ }
        }
        return !this._disposed && this.context === context && context.state === 'running';
    }

    _buildGraph() {
        const ctx = this.context;

        this.ambienceBus = ctx.createGain();
        this.cueBus = ctx.createGain();
        this.duckGain = ctx.createGain();
        this.mixBus = ctx.createGain();
        this.fadeGain = ctx.createGain();
        this.fadeGain.gain.value = MIN_GAIN;
        this.masterGain = ctx.createGain();
        this.masterGain.gain.value = this._volumeGain();

        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 6200;
        tone.Q.value = 0.4;

        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -10;
        limiter.knee.value = 16;
        limiter.ratio.value = 6;
        limiter.attack.value = 0.01;
        limiter.release.value = 0.4;

        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this._analyserData = new Float32Array(this.analyser.fftSize);

        this.ambienceBus.connect(this.duckGain).connect(this.mixBus);
        this.cueBus.connect(this.mixBus);
        this.mixBus.connect(this.fadeGain)
            .connect(this.masterGain)
            .connect(tone)
            .connect(limiter)
            .connect(this.analyser)
            .connect(ctx.destination);
    }

    noise(type = 'white') {
        if (!this.context) return null;
        if (!this._noiseBuffers.has(type)) {
            this._noiseBuffers.set(type, buildNoiseBuffer(this.context, type));
        }
        return this._noiseBuffers.get(type);
    }

    // Cached console-style timbres: band-limited pulse waves (NES duty
    // cycles) and a soft flute (sine plus a whisper of harmonics).
    wave(name) {
        if (!this.context) return null;
        if (!this._waves) this._waves = new Map();
        if (!this._waves.has(name)) {
            const ctx = this.context;
            let wave = null;
            if (name === 'pulse25' || name === 'pulse12') {
                const duty = name === 'pulse25' ? 0.25 : 0.125;
                const n = 24;
                const real = new Float32Array(n);
                const imag = new Float32Array(n);
                for (let k = 1; k < n; k++) {
                    imag[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
                }
                wave = ctx.createPeriodicWave(real, imag);
            } else if (name === 'flute') {
                wave = ctx.createPeriodicWave(
                    new Float32Array([0, 0, 0, 0, 0]),
                    new Float32Array([0, 1, 0.22, 0.1, 0.04]),
                );
            }
            this._waves.set(name, wave);
        }
        return this._waves.get(name);
    }

    start() {
        if (this._disposed || !this.context || !this.fadeGain) return;
        this.started = true;
        const now = this.now();
        this.fadeGain.gain.cancelScheduledValues(now);
        this.fadeGain.gain.setTargetAtTime(1, now, 0.4);
    }

    stop() {
        if (!this.context || !this.fadeGain) return;
        this.started = false;
        const now = this.now();
        this.fadeGain.gain.cancelScheduledValues(now);
        this.fadeGain.gain.setTargetAtTime(MIN_GAIN, now, 0.16);
    }

    async suspend() {
        const context = this.context;
        if (!context || context.state !== 'running') return;
        try { await context.suspend(); } catch { /* best effort */ }
    }

    setVolume(value) {
        this.volume = clamp01(value, 0.5);
        if (!this.masterGain) return;
        this.masterGain.gain.setTargetAtTime(this._volumeGain(), this.now(), 0.05);
    }

    // Perceptual volume: square the slider value so mid-slider feels mid-loud.
    _volumeGain() {
        return Math.max(MIN_GAIN, this.volume * this.volume * 0.9);
    }

    // Duck the ambience bus under a cue, then recover.
    duck(depth = 0.4, holdSec = 0.6) {
        if (!this.duckGain) return;
        const now = this.now();
        const g = this.duckGain.gain;
        g.cancelScheduledValues(now);
        g.setTargetAtTime(1 - clamp01(depth), now, 0.06);
        g.setTargetAtTime(1, now + holdSec, 0.9);
    }

    // Post-mix RMS, for QA: lets a headless browser check "is sound actually
    // playing and does it get louder in a storm" without ears.
    rms() {
        if (!this.analyser || !this._analyserData) return 0;
        this.analyser.getFloatTimeDomainData(this._analyserData);
        let sum = 0;
        for (let i = 0; i < this._analyserData.length; i++) {
            sum += this._analyserData[i] * this._analyserData[i];
        }
        return Math.sqrt(sum / this._analyserData.length);
    }

    async dispose() {
        if (this._disposePromise) return this._disposePromise;
        this._disposed = true;
        this.started = false;
        const context = this.context;
        this.context = null;
        this.ambienceBus = null;
        this.cueBus = null;
        this.duckGain = null;
        this.mixBus = null;
        this.fadeGain = null;
        this.masterGain = null;
        this.analyser = null;
        this._noiseBuffers.clear();
        this._waves = null;
        this._disposePromise = (async () => {
            if (context) {
                try { await context.close(); } catch { /* already closed */ }
            }
        })();
        return this._disposePromise;
    }
}
