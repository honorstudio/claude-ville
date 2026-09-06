// Birdsong: short frequency-glide chirp phrases with long randomized rests.
// Intensity controls both loudness and phrase density — a dawn chorus sings
// every few seconds, a quiet afternoon only occasionally. Rain, storm, night
// and winter suppression happen upstream in the director.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand, pick } from '../AudioEngine.js';

export class BirdsLayer extends BaseLayer {
    constructor(engine) {
        super(engine, { trim: 0.55 });
    }

    _start(_ctx) {
        this._scheduleNext(2000);
    }

    _scheduleNext(minMs = null) {
        const density = Math.max(this.level, 0.001);
        const rest = minMs ?? (5000 + (1 - density) * 26000) * rand(0.6, 1.6);
        this.timer(() => {
            if (this.level > 0.04) this._phrase();
            this._scheduleNext();
        }, rest);
    }

    _phrase() {
        const ctx = this.engine.context;
        if (!ctx || !this.out) return;
        const chirps = 2 + Math.floor(rand(0, 4));
        const panValue = rand(-0.6, 0.6);
        const baseHz = rand(2300, 4100);
        let t = ctx.currentTime + 0.05;
        for (let i = 0; i < chirps; i++) {
            this._chirp(t, baseHz * rand(0.92, 1.12), panValue);
            t += rand(0.14, 0.34);
        }
    }

    _chirp(t, f0, panValue) {
        const ctx = this.engine.context;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        const dur = rand(0.05, 0.11);

        osc.type = 'sine';
        const shape = pick(['rise', 'fall', 'warble']);
        osc.frequency.setValueAtTime(f0, t);
        if (shape === 'rise') {
            osc.frequency.exponentialRampToValueAtTime(f0 * rand(1.2, 1.5), t + dur);
        } else if (shape === 'fall') {
            osc.frequency.exponentialRampToValueAtTime(f0 * rand(0.65, 0.85), t + dur);
        } else {
            osc.frequency.exponentialRampToValueAtTime(f0 * 1.3, t + dur * 0.4);
            osc.frequency.exponentialRampToValueAtTime(f0 * 0.9, t + dur);
        }

        gain.gain.setValueAtTime(MIN_GAIN, t);
        gain.gain.exponentialRampToValueAtTime(rand(0.02, 0.035), t + 0.008);
        gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur + 0.06);

        if (pan) {
            pan.pan.value = panValue;
            osc.connect(gain).connect(pan).connect(this.out);
        } else {
            osc.connect(gain).connect(this.out);
        }
        osc.start(t);
        osc.stop(t + dur + 0.1);
        osc.onended = () => {
            try { osc.disconnect(); gain.disconnect(); pan?.disconnect(); } catch { /* gone */ }
        };
    }
}
