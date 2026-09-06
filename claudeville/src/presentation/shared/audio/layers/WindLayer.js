// Wind bed: low-passed brown noise with slow gust undulation. Nearly silent
// on a calm clear day; rises with weather intensity, brightens with wind
// speed, muffles under fog. Replaces the old fixed 620 Hz "air" hiss.

import { BaseLayer } from './BaseLayer.js';

export class WindLayer extends BaseLayer {
    constructor(engine) {
        super(engine, { trim: 0.16 });
        this.filter = null;
        this.gustDepth = null;
    }

    _start(ctx) {
        const source = ctx.createBufferSource();
        source.buffer = this.engine.noise('brown');
        source.loop = true;

        this.filter = ctx.createBiquadFilter();
        this.filter.type = 'lowpass';
        this.filter.frequency.value = 420;
        this.filter.Q.value = 0.6;

        // Body gain the gust LFOs breathe against.
        const body = ctx.createGain();
        body.gain.value = 0.7;

        // Two incommensurate LFOs so gusts wander instead of pulsing.
        const gust = ctx.createOscillator();
        gust.type = 'sine';
        gust.frequency.value = 0.07;
        this.gustDepth = ctx.createGain();
        this.gustDepth.gain.value = 0.18;
        gust.connect(this.gustDepth).connect(body.gain);

        const wander = ctx.createOscillator();
        wander.type = 'sine';
        wander.frequency.value = 0.019;
        const wanderDepth = ctx.createGain();
        wanderDepth.gain.value = 0.1;
        wander.connect(wanderDepth).connect(body.gain);

        // Gusts also open the filter slightly so louder means brighter.
        const filterMod = ctx.createGain();
        filterMod.gain.value = 130;
        gust.connect(filterMod).connect(this.filter.frequency);

        source.connect(this.filter).connect(body).connect(this.out);
        const t = ctx.currentTime;
        source.start(t);
        gust.start(t);
        wander.start(t);

        this.trackSource(source, gust, wander);
        this.track(this.filter, body, this.gustDepth, wanderDepth, filterMod);
    }

    // strength 0..1 overall wind presence; wind = |windX| 0..1.4; fog 0..1.
    setWind({ strength = 0, wind = 0, fog = 0 } = {}) {
        this.setLevel(strength, 4);
        if (!this.filter || !this.engine.context) return;
        const now = this.engine.now();
        const cutoff = 260 + wind * 320 + strength * 300 - fog * 140;
        this.filter.frequency.setTargetAtTime(Math.max(140, cutoff), now, 5);
        this.gustDepth.gain.setTargetAtTime(0.08 + strength * 0.28, now, 5);
    }
}
