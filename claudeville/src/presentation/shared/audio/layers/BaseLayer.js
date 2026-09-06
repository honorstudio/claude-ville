// Common plumbing for ambience layers: an output gain on the ambience bus,
// smooth intensity targeting, timer bookkeeping for scheduled layers, and
// teardown that fades before disconnecting so stops never click.

import { MIN_GAIN } from '../AudioEngine.js';

export class BaseLayer {
    constructor(engine, { trim = 0.1 } = {}) {
        this.engine = engine;
        this.trim = trim;
        this.level = 0;
        this.running = false;
        this.out = null;
        this._nodes = [];
        this._sources = [];
        this._timers = new Set();
    }

    start() {
        if (this.running || !this.engine.context) return;
        const ctx = this.engine.context;
        this.out = ctx.createGain();
        this.out.gain.value = MIN_GAIN;
        this.out.connect(this.engine.ambienceBus);
        this.running = true;
        this._start(ctx);
    }

    // Subclasses build their graph here; nodes registered via track()/trackSource().
    _start(_ctx) {}

    // Intensity 0..1, scaled by the layer's mix trim. Long time constants keep
    // every change inaudible as a transition.
    setLevel(value, timeConstant = 3) {
        this.level = Math.max(0, Math.min(1, Number(value) || 0));
        if (!this.out || !this.engine.context) return;
        const target = Math.max(MIN_GAIN, this.level * this.trim);
        this.out.gain.setTargetAtTime(target, this.engine.now(), timeConstant);
    }

    track(...nodes) {
        for (const node of nodes) if (node) this._nodes.push(node);
    }

    trackSource(...sources) {
        for (const source of sources) if (source) this._sources.push(source);
    }

    // setTimeout wrapper that self-cleans and no-ops after stop().
    timer(fn, ms) {
        const id = setTimeout(() => {
            this._timers.delete(id);
            if (this.running) fn();
        }, ms);
        this._timers.add(id);
        return id;
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        for (const id of this._timers) clearTimeout(id);
        this._timers.clear();

        const now = this.engine.now();
        if (this.out) {
            this.out.gain.cancelScheduledValues(now);
            this.out.gain.setTargetAtTime(MIN_GAIN, now, 0.15);
        }
        for (const source of this._sources) {
            try { source.stop(now + 0.6); } catch { /* already stopped */ }
        }
        const doomed = [...this._sources, ...this._nodes, this.out];
        setTimeout(() => {
            for (const node of doomed) {
                try { node?.disconnect?.(); } catch { /* already disconnected */ }
            }
        }, 900);
        this._sources = [];
        this._nodes = [];
        this.out = null;
    }
}
