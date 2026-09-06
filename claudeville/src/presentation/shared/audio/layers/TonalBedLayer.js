// Tonal bed: occasional long swells of one or two low scale tones with
// 20–40 s of silence between them. Replaces the old always-on pad — the
// bed is felt more than heard, and most of the time it is simply quiet.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand, pick } from '../AudioEngine.js';
import { noteHz, scaleForPhase } from '../MusicalScale.js';

export class TonalBedLayer extends BaseLayer {
    constructor(engine) {
        super(engine, { trim: 0.09 });
        this.scale = scaleForPhase('day');
        this.filter = null;
    }

    _start(ctx) {
        this.filter = ctx.createBiquadFilter();
        this.filter.type = 'lowpass';
        this.filter.frequency.value = 600;
        this.filter.Q.value = 0.5;
        this.filter.connect(this.out);
        this.track(this.filter);
        this._scheduleSwell(rand(3000, 9000));
    }

    setScale(scale) {
        this.scale = scale || this.scale;
        if (!this.filter || !this.engine.context) return;
        const cutoff = 350 + this.scale.brightness * 550;
        this.filter.frequency.setTargetAtTime(cutoff, this.engine.now(), 8);
    }

    _scheduleSwell(minMs = null) {
        const rest = minMs ?? rand(16000, 42000);
        this.timer(() => {
            if (this.level > 0.02) this._swell();
            this._scheduleSwell();
        }, rest);
    }

    // One swell: a bass tone, sometimes joined by a fifth or octave, each as
    // a detuned sine pair with a very slow attack and release.
    _swell() {
        const ctx = this.engine.context;
        if (!ctx || !this.filter) return;
        const bass = this.scale.bass;
        const intervals = Math.random() < 0.55 ? [0] : [0, pick([7, 12])];
        const attack = rand(7, 13);
        const hold = rand(3, 6);
        const release = rand(9, 16);
        const t = ctx.currentTime + 0.05;

        for (const interval of intervals) {
            const hz = noteHz(bass + interval);
            const noteGain = ctx.createGain();
            noteGain.gain.setValueAtTime(MIN_GAIN, t);
            noteGain.gain.setTargetAtTime(interval === 0 ? 0.5 : 0.3, t, attack / 3);
            noteGain.gain.setTargetAtTime(MIN_GAIN, t + attack + hold, release / 3);
            noteGain.connect(this.filter);

            const oscs = [];
            for (const cents of [-4, 4]) {
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = hz;
                osc.detune.value = cents;
                osc.connect(noteGain);
                osc.start(t);
                osc.stop(t + attack + hold + release + 4);
                oscs.push(osc);
            }
            oscs[0].onended = () => {
                try {
                    noteGain.disconnect();
                    for (const osc of oscs) osc.disconnect();
                } catch { /* gone */ }
            };
        }
    }
}
