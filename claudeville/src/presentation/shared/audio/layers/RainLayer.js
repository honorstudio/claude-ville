// Rain: broadband high patter scaled by precipitation, sparse pitched
// droplet grains for close texture, and a low storm rumble bed. Winter
// (snow on screen) is handled upstream — the director mutes precipitation
// so snowfall stays hushed with only wind carrying the scene.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand } from '../AudioEngine.js';

export class RainLayer extends BaseLayer {
    constructor(engine) {
        super(engine, { trim: 0.2 });
        this.precipitation = 0;
        this.patterGain = null;
        this.rumbleGain = null;
    }

    _start(ctx) {
        // The out gain stays at full trim; sub-gains do the mixing so patter
        // and rumble can move independently.
        this.setLevel(1, 0.1);

        const patterSrc = ctx.createBufferSource();
        patterSrc.buffer = this.engine.noise('white');
        patterSrc.loop = true;

        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1500;
        hp.Q.value = 0.5;

        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 6800;
        lp.Q.value = 0.4;

        this.patterGain = ctx.createGain();
        this.patterGain.gain.value = MIN_GAIN;

        const rumbleSrc = ctx.createBufferSource();
        rumbleSrc.buffer = this.engine.noise('brown');
        rumbleSrc.loop = true;

        const rumbleLp = ctx.createBiquadFilter();
        rumbleLp.type = 'lowpass';
        rumbleLp.frequency.value = 120;
        rumbleLp.Q.value = 0.5;

        this.rumbleGain = ctx.createGain();
        this.rumbleGain.gain.value = MIN_GAIN;

        patterSrc.connect(hp).connect(lp).connect(this.patterGain).connect(this.out);
        rumbleSrc.connect(rumbleLp).connect(this.rumbleGain).connect(this.out);

        const t = ctx.currentTime;
        patterSrc.start(t);
        rumbleSrc.start(t);

        this.trackSource(patterSrc, rumbleSrc);
        this.track(hp, lp, this.patterGain, rumbleLp, this.rumbleGain);
        this._scheduleDroplet();
    }

    setPrecipitation(p) {
        this.precipitation = Math.max(0, Math.min(1, Number(p) || 0));
        if (!this.patterGain || !this.engine.context) return;
        const target = this.precipitation > 0.02 ? this.precipitation * 0.55 : MIN_GAIN;
        this.patterGain.gain.setTargetAtTime(Math.max(MIN_GAIN, target), this.engine.now(), 4);
    }

    setStorm(intensity) {
        if (!this.rumbleGain || !this.engine.context) return;
        const v = Math.max(0, Math.min(1, Number(intensity) || 0));
        this.rumbleGain.gain.setTargetAtTime(Math.max(MIN_GAIN, v * 0.4), this.engine.now(), 6);
    }

    _scheduleDroplet() {
        const p = this.precipitation;
        const interval = p > 0.05 ? rand(140, 900 - p * 650) : 1500;
        this.timer(() => {
            if (this.precipitation > 0.05) this._droplet();
            this._scheduleDroplet();
        }, interval);
    }

    // One close droplet: a fast downward pitch chirp, panned at random.
    _droplet() {
        const ctx = this.engine.context;
        if (!ctx || !this.out) return;
        const t = ctx.currentTime + 0.01;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

        osc.type = 'sine';
        const f0 = rand(1800, 3400);
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(f0 * 0.4, t + 0.03);

        const peak = 0.006 + this.precipitation * 0.014;
        gain.gain.setValueAtTime(MIN_GAIN, t);
        gain.gain.exponentialRampToValueAtTime(peak, t + 0.006);
        gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t + rand(0.05, 0.12));

        if (pan) {
            pan.pan.value = rand(-0.7, 0.7);
            osc.connect(gain).connect(pan).connect(this.out);
        } else {
            osc.connect(gain).connect(this.out);
        }
        osc.start(t);
        osc.stop(t + 0.16);
        osc.onended = () => {
            try { osc.disconnect(); gain.disconnect(); pan?.disconnect(); } catch { /* gone */ }
        };
    }
}
