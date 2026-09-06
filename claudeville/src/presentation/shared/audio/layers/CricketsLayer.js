// Night crickets: two "individuals" with their own rhythms and stereo
// positions, each chirruping in pulse clusters. Summer nights are dense,
// spring/autumn sparse, winter silent (season gating upstream).

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand } from '../AudioEngine.js';

const VOICES = [
    { hz: 4150, intervalMs: 560, pan: -0.45 },
    { hz: 4480, intervalMs: 810, pan: 0.4 },
];

export class CricketsLayer extends BaseLayer {
    constructor(engine) {
        super(engine, { trim: 0.7 });
    }

    _start(ctx) {
        for (const voice of VOICES) {
            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = voice.hz;
            filter.Q.value = 7;
            const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
            if (pan) {
                pan.pan.value = voice.pan;
                filter.connect(pan).connect(this.out);
            } else {
                filter.connect(this.out);
            }
            this.track(filter, pan);
            this._loopVoice(voice, filter);
        }
    }

    _loopVoice(voice, filter) {
        this.timer(() => {
            if (this.level > 0.03) this._chirrup(voice, filter);
            this._loopVoice(voice, filter);
        }, voice.intervalMs * rand(0.8, 1.35));
    }

    // A chirrup: 3–4 fast pulses of a narrow-band triangle tone.
    _chirrup(voice, filter) {
        const ctx = this.engine.context;
        if (!ctx) return;
        const pulses = 3 + (Math.random() < 0.35 ? 1 : 0);
        let t = ctx.currentTime + 0.02;

        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = voice.hz * rand(0.98, 1.02);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(MIN_GAIN, t);
        for (let i = 0; i < pulses; i++) {
            gain.gain.exponentialRampToValueAtTime(0.05, t + 0.006);
            gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.028);
            t += 0.045;
        }
        osc.connect(gain).connect(filter);
        osc.start();
        osc.stop(t + 0.05);
        osc.onended = () => {
            try { osc.disconnect(); gain.disconnect(); } catch { /* gone */ }
        };
    }
}
