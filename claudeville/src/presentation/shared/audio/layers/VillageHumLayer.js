// Village industry: a faint low murmur plus occasional wood-knock and
// hammer-tap grains whose density follows how many agents are working.
// Silent when the village is idle; suppressed at night by the director.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand } from '../AudioEngine.js';

export class VillageHumLayer extends BaseLayer {
    constructor(engine) {
        super(engine, { trim: 0.15 });
        this.murmurGain = null;
    }

    _start(ctx) {
        const src = ctx.createBufferSource();
        src.buffer = this.engine.noise('brown');
        src.loop = true;

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 300;
        bp.Q.value = 0.7;

        this.murmurGain = ctx.createGain();
        this.murmurGain.gain.value = 0.12;

        src.connect(bp).connect(this.murmurGain).connect(this.out);
        src.start(ctx.currentTime);
        this.trackSource(src);
        this.track(bp, this.murmurGain);
        this._scheduleTap();
    }

    _scheduleTap() {
        const density = Math.max(this.level, 0.001);
        const interval = (2200 + (1 - density) * 7000) * rand(0.6, 1.5);
        this.timer(() => {
            if (this.level > 0.05) this._tap();
            this._scheduleTap();
        }, interval);
    }

    // A soft work sound: filtered noise knock; sometimes a double hammer tap.
    _tap() {
        const ctx = this.engine.context;
        if (!ctx || !this.out) return;
        const double = Math.random() < 0.3;
        const centerHz = rand(650, 1500);
        const panValue = rand(-0.5, 0.5);
        this._knock(ctx.currentTime + 0.02, centerHz, panValue);
        if (double) this._knock(ctx.currentTime + 0.02 + rand(0.11, 0.16), centerHz * rand(0.96, 1.05), panValue);
    }

    _knock(t, centerHz, panValue) {
        const ctx = this.engine.context;
        const src = ctx.createBufferSource();
        src.buffer = this.engine.noise('white');

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = centerHz;
        bp.Q.value = 6;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(MIN_GAIN, t);
        gain.gain.exponentialRampToValueAtTime(rand(0.03, 0.05), t + 0.004);
        gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t + rand(0.06, 0.11));

        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (pan) {
            pan.pan.value = panValue;
            src.connect(bp).connect(gain).connect(pan).connect(this.out);
        } else {
            src.connect(bp).connect(gain).connect(this.out);
        }
        src.start(t);
        src.stop(t + 0.16);
        src.onended = () => {
            try { src.disconnect(); bp.disconnect(); gain.disconnect(); pan?.disconnect(); } catch { /* gone */ }
        };
    }
}
