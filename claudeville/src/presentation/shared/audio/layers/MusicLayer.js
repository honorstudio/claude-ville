// Village music: a small generative composer in the retro-game tradition.
//
// Instead of looping one melody, the layer holds a songbook of authored
// tunes — each a pair of 4-bar sections (A, B) over a chord progression —
// and performs them: it picks a song and a form (A-A-B-A, A-B-A-A, ...),
// plays a one-bar pickup, varies repeated sections (timbre swap, phrase-end
// fills), accompanies with plucked arpeggios or soft chord stabs, walks the
// bass in root–fifth motion, and closes with a ring-out outro. Between songs
// it rests, then plays a different tune.
//
// Voices are classic console timbres built with PeriodicWave: 25%/12.5%
// duty pulse leads, a flute-ish sine stack for night, triangle bass. Held
// notes get delayed-onset vibrato; note timing and velocity are humanized.
// Day songs are major-pentatonic over I-IV-V-vi harmony; night songs are
// minor-pentatonic lullabies — always inside the shared tonal center so the
// bed and cues never clash.
//
// Sections are scheduled one at a time, so a phase change (day → night)
// finishes the current song with an outro and picks up the right songbook.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand, pick } from '../AudioEngine.js';
import { noteHz } from '../MusicalScale.js';

// Chord voicings (semitones from A4, mid-low register) and bass roots.
const CHORDS = {
    'A': [-12, -8, -5],
    'D': [-19, -15, -12],
    'E': [-17, -13, -10],
    'F#m': [-15, -12, -8],
    'Am': [-12, -9, -5],
    'C': [-21, -17, -14],
    'Em': [-17, -14, -10],
    'F': [-16, -12, -9],
    'G': [-14, -10, -7],
};
const BASS_ROOT = {
    'A': -24, 'D': -19, 'E': -29, 'F#m': -27,
    'Am': -24, 'C': -21, 'Em': -29, 'F': -28, 'G': -26,
};

// Pentatonic pools for ornament fills.
const PENT = {
    major: [-12, -10, -8, -5, -3, 0, 2, 4, 7, 9],
    minor: [-12, -9, -7, -5, -2, 0, 3, 5, 7, 10],
};

// Melody notes are [semitonesFromA4, beats]; null pitch is a rest.
// Every section is 4 bars of 4/4 with one chord per bar.
const SONGS = {
    major: [
        {
            name: 'hearthfire', bpm: 88,
            lead: 'pulse25', leadAlt: 'flute',
            sections: {
                A: {
                    chords: ['A', 'D', 'A', 'E'], accomp: 'arp8',
                    melody: [
                        [-5, 1], [-3, 0.5], [0, 0.5], [2, 1], [4, 1],
                        [0, 1], [-3, 0.5], [-5, 0.5], [-3, 2],
                        [-5, 1], [-8, 0.5], [-5, 0.5], [0, 1], [2, 1],
                        [2, 1.5], [0, 0.5], [2, 2],
                    ],
                },
                B: {
                    chords: ['F#m', 'D', 'A', 'E'], accomp: 'block2',
                    melody: [
                        [4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1],
                        [2, 1], [0, 0.5], [-3, 0.5], [-5, 2],
                        [-8, 1], [-5, 0.5], [-3, 0.5], [0, 1], [-3, 1],
                        [2, 2], [-5, 2],
                    ],
                },
            },
        },
        {
            name: 'millbrook', bpm: 72,
            lead: 'pulse25', leadAlt: 'flute',
            sections: {
                A: {
                    chords: ['A', 'F#m', 'D', 'E'], accomp: 'arp8',
                    melody: [
                        [0, 2], [4, 1], [2, 1],
                        [0, 1], [-3, 1], [-5, 2],
                        [-3, 1], [0, 0.5], [2, 0.5], [4, 1], [2, 1],
                        [2, 3], [null, 1],
                    ],
                },
                B: {
                    chords: ['D', 'A', 'F#m', 'E'], accomp: 'block2',
                    melody: [
                        [9, 1], [7, 1], [4, 2],
                        [7, 1], [4, 0.5], [2, 0.5], [0, 2],
                        [4, 1], [0, 1], [-3, 2],
                        [-5, 1], [-3, 1], [2, 2],
                    ],
                },
            },
        },
    ],
    minor: [
        {
            name: 'lanternway', bpm: 56,
            lead: 'flute', leadAlt: 'pulse12',
            sections: {
                A: {
                    chords: ['Am', 'Am', 'C', 'Em'], accomp: 'block1',
                    melody: [
                        [0, 2], [-2, 1], [-5, 1],
                        [-7, 1], [-5, 1], [-9, 2],
                        [-12, 1], [-9, 1], [-7, 1], [-5, 1],
                        [-5, 3], [null, 1],
                    ],
                },
                B: {
                    chords: ['F', 'G', 'Am', 'Am'], accomp: 'arpQ',
                    melody: [
                        [3, 2], [0, 1], [-2, 1],
                        [-2, 1], [-5, 0.5], [-7, 0.5], [-2, 2],
                        [0, 1], [-2, 0.5], [-5, 0.5], [-7, 1], [-9, 1],
                        [-12, 4],
                    ],
                },
            },
        },
        {
            name: 'starwake', bpm: 60,
            lead: 'flute', leadAlt: 'pulse12',
            sections: {
                A: {
                    chords: ['Am', 'C', 'G', 'Am'], accomp: 'arpQ',
                    melody: [
                        [-5, 1.5], [-2, 0.5], [0, 2],
                        [-2, 1], [-5, 1], [-9, 2],
                        [-7, 1], [-5, 0.5], [-2, 0.5], [-7, 2],
                        [-12, 3], [null, 1],
                    ],
                },
                B: {
                    chords: ['F', 'C', 'G', 'Am'], accomp: 'block1',
                    melody: [
                        [3, 2], [0, 2],
                        [-2, 1.5], [-5, 0.5], [-2, 2],
                        [-7, 1], [-2, 1], [-5, 2],
                        [-12, 4],
                    ],
                },
            },
        },
    ],
};

const FORMS = [
    ['A', 'A', 'B', 'A'],
    ['A', 'B', 'A', 'A'],
    ['A', 'A', 'B', 'B'],
];

const ARRANGEMENTS = {
    dawn: { family: 'major', tempoScale: 0.9, octave: 0, gain: 0.8 },
    day: { family: 'major', tempoScale: 1, octave: 0, gain: 1 },
    dusk: { family: 'major', tempoScale: 0.8, octave: -12, gain: 0.9 },
    night: { family: 'minor', tempoScale: 1, octave: 0, gain: 0.85 },
};

const BEATS_PER_BAR = 4;
const SECTION_BARS = 4;

export class MusicLayer extends BaseLayer {
    constructor(engine) {
        super(engine, { trim: 0.5 });
        this.phase = 'day';
        this.restScale = 1;
        this.nowPlaying = null;
        this.melodyBus = null;
        this.accompBus = null;
        this.bassBus = null;
        this._waves = null;
        this._songSources = new Set();
        this._plan = null;
        this._lastSongName = null;
    }

    _start(ctx) {
        this._waves = {
            pulse25: this.engine.wave('pulse25'),
            pulse12: this.engine.wave('pulse12'),
            flute: this.engine.wave('flute'),
        };

        const melodyTone = ctx.createBiquadFilter();
        melodyTone.type = 'lowpass';
        melodyTone.frequency.value = 2600;
        melodyTone.Q.value = 0.4;
        this.melodyBus = ctx.createGain();
        this.melodyBus.connect(melodyTone).connect(this.out);

        const accompTone = ctx.createBiquadFilter();
        accompTone.type = 'lowpass';
        accompTone.frequency.value = 1700;
        accompTone.Q.value = 0.4;
        this.accompBus = ctx.createGain();
        this.accompBus.connect(accompTone).connect(this.out);

        const bassTone = ctx.createBiquadFilter();
        bassTone.type = 'lowpass';
        bassTone.frequency.value = 800;
        bassTone.Q.value = 0.4;
        this.bassBus = ctx.createGain();
        this.bassBus.connect(bassTone).connect(this.out);

        // Echo on the lead for "heard across the square" distance.
        const delay = ctx.createDelay(1.5);
        delay.delayTime.value = 0.38;
        const feedback = ctx.createGain();
        feedback.gain.value = 0.14;
        const delayTone = ctx.createBiquadFilter();
        delayTone.type = 'lowpass';
        delayTone.frequency.value = 1900;
        delayTone.Q.value = 0.3;
        const delayReturn = ctx.createGain();
        delayReturn.gain.value = 0.11;
        const delaySend = ctx.createGain();
        delaySend.gain.value = 0.22;

        this.melodyBus.connect(delaySend).connect(delay);
        delay.connect(delayTone).connect(feedback).connect(delay);
        delayTone.connect(delayReturn).connect(this.out);

        this.track(melodyTone, this.melodyBus, accompTone, this.accompBus,
            bassTone, this.bassBus, delay, feedback, delayTone, delayReturn, delaySend);
        this._scheduleSong(rand(2500, 5000));
    }

    setPhase(phase) {
        if (ARRANGEMENTS[phase]) this.phase = phase;
    }

    setRestScale(value) {
        this.restScale = Math.max(0.4, Math.min(1.6, Number(value) || 1));
    }

    _scheduleSong(delayMs) {
        this.timer(() => {
            if (this.level > 0.04 && !this._plan) this._playSong();
            else this._scheduleSong(4000);
        }, delayMs);
    }

    _playSong() {
        const ctx = this.engine.context;
        if (!ctx || !this.melodyBus) return;
        const arrangement = ARRANGEMENTS[this.phase] || ARRANGEMENTS.day;
        const book = SONGS[arrangement.family];
        const candidates = book.filter(s => s.name !== this._lastSongName);
        const song = pick(candidates.length ? candidates : book);
        this._lastSongName = song.name;

        const form = pick(FORMS);
        const queue = [
            { kind: 'pickup' },
            ...form.map(kind => ({ kind })),
            { kind: 'outro' },
        ];
        // Repeated sections vary: first pass plain, later passes swap the
        // lead timbre or add a phrase-end fill.
        const seen = {};
        for (const step of queue) {
            if (step.kind !== 'A' && step.kind !== 'B') continue;
            seen[step.kind] = (seen[step.kind] || 0) + 1;
            if (seen[step.kind] > 1) step.variation = pick(['timbre', 'fill']);
        }

        this._plan = { song, arrangement, queue };
        this._sectionAt(ctx.currentTime + 0.15, 0);
    }

    _sectionAt(t0, index) {
        const ctx = this.engine.context;
        const plan = this._plan;
        if (!ctx || !plan || !this.running) return;

        if (index >= plan.queue.length) {
            this._plan = null;
            this.nowPlaying = null;
            this._scheduleSong(rand(9000, 22000) * this.restScale);
            return;
        }

        const { song, arrangement } = plan;
        const step = plan.queue[index];
        const beatSec = 60 / (song.bpm * arrangement.tempoScale);
        const barSec = BEATS_PER_BAR * beatSec;
        let duration;

        if (step.kind === 'pickup') {
            duration = barSec;
            this._schedulePickup(t0, beatSec, song, arrangement);
        } else if (step.kind === 'outro') {
            duration = barSec * 1.5;
            this._scheduleOutro(t0, barSec, song, arrangement);
        } else {
            duration = SECTION_BARS * barSec;
            this._scheduleSection(t0, beatSec, song, arrangement, step);
        }
        this.nowPlaying = { song: song.name, section: step.kind, index, variation: step.variation || null };

        // Chain the next section well before this one ends (browser timers
        // can be clamped ~1 s in throttled tabs); if the phase family flipped
        // meanwhile (day → night), jump straight to the outro.
        const waitMs = Math.max(50, (t0 + duration - ctx.currentTime - 1.5) * 1000);
        this.timer(() => {
            const nowFamily = (ARRANGEMENTS[this.phase] || ARRANGEMENTS.day).family;
            let next = index + 1;
            if (nowFamily !== arrangement.family) {
                const outroIndex = plan.queue.findIndex((s, i) => i > index && s.kind === 'outro');
                if (outroIndex > 0 && plan.queue[next]?.kind !== 'outro') next = outroIndex;
            }
            this._sectionAt(t0 + duration, next);
        }, waitMs);
    }

    _schedulePickup(t0, beatSec, song, arrangement) {
        const chord = song.sections.A.chords[0];
        this._bassBar(t0, beatSec, chord, arrangement, { rootOnly: true });
        this._accompBar(t0, beatSec, chord, 'arpQ', arrangement);
    }

    _scheduleOutro(t0, barSec, song, arrangement) {
        const chord = song.sections.A.chords[0];
        const root = BASS_ROOT[chord];
        const beatSec = barSec / BEATS_PER_BAR;
        this._playNote(this.bassBus, t0, noteHz(root), barSec * 1.3, 'triangle', 0.055 * arrangement.gain, { staccato: 1 });
        // Lead holds root + fifth, letting the echo tail ring out.
        const lead = this._waves[song.lead] ? song.lead : 'flute';
        this._playNote(this.melodyBus, t0, noteHz(root + 24 + arrangement.octave), barSec * 1.2, lead, 0.035 * arrangement.gain, { vibrato: true, staccato: 1 });
        this._playNote(this.melodyBus, t0 + beatSec, noteHz(root + 31 + arrangement.octave), barSec, lead, 0.024 * arrangement.gain, { vibrato: true, staccato: 1 });
    }

    _scheduleSection(t0, beatSec, song, arrangement, step) {
        const section = song.sections[step.kind];
        const timbre = step.variation === 'timbre' ? song.leadAlt : song.lead;
        const melody = step.variation === 'fill'
            ? this._withFill(section.melody, arrangement)
            : section.melody;

        this._scheduleMelody(t0, beatSec, melody, timbre, arrangement);
        for (let bar = 0; bar < SECTION_BARS; bar++) {
            const chord = section.chords[bar] || section.chords[section.chords.length - 1];
            const barStart = t0 + bar * BEATS_PER_BAR * beatSec;
            this._bassBar(barStart, beatSec, chord, arrangement, {});
            this._accompBar(barStart, beatSec, chord, section.accomp, arrangement);
        }
    }

    // Replace the section's final long note with a held note plus two
    // pentatonic passing eighths — a little end-of-phrase flourish.
    _withFill(melody, arrangement) {
        const last = melody[melody.length - 1];
        if (!last || last[0] == null || last[1] < 2) return melody;
        const pool = PENT[arrangement.family];
        const i = pool.indexOf(last[0]);
        if (i < 1) return melody;
        const upper = pool[Math.min(pool.length - 1, i + 1)];
        return [
            ...melody.slice(0, -1),
            [last[0], last[1] - 1],
            [upper, 0.5],
            [pool[i - 1], 0.5],
        ];
    }

    _scheduleMelody(t0, beatSec, melody, timbre, arrangement) {
        let beat = 0;
        for (const [semi, beats] of melody) {
            if (semi != null) {
                const t = t0 + beat * beatSec + rand(-0.007, 0.007);
                const onDownbeat = beat % BEATS_PER_BAR === 0;
                const gain = 0.042 * arrangement.gain * (onDownbeat ? 1.12 : rand(0.85, 1));
                this._playNote(this.melodyBus, t, noteHz(semi + arrangement.octave),
                    beats * beatSec, timbre, gain,
                    { vibrato: beats >= 1.5, staccato: 0.92 });
            }
            beat += beats;
        }
    }

    _bassBar(t0, beatSec, chord, arrangement, { rootOnly = false } = {}) {
        const root = BASS_ROOT[chord];
        if (root == null) return;
        const gain = 0.055 * arrangement.gain;
        this._playNote(this.bassBus, t0, noteHz(root), beatSec * 1.7, 'triangle', gain, { staccato: 0.95 });
        if (!rootOnly) {
            this._playNote(this.bassBus, t0 + 2 * beatSec, noteHz(root + 7), beatSec * 1.7, 'triangle', gain * 0.85, { staccato: 0.95 });
        }
    }

    _accompBar(t0, beatSec, chord, style, arrangement) {
        const tones = CHORDS[chord];
        if (!tones) return;
        const gain = 0.015 * arrangement.gain;

        if (style === 'arp8' || style === 'arpQ') {
            const stepSec = style === 'arp8' ? beatSec / 2 : beatSec;
            const count = style === 'arp8' ? 8 : 4;
            const pattern = [0, 1, 2, 1];
            for (let i = 0; i < count; i++) {
                const semi = tones[pattern[i % pattern.length]];
                this._playNote(this.accompBus, t0 + i * stepSec, noteHz(semi),
                    Math.min(0.3, stepSec * 0.9), 'pulse12', gain, { pluck: true });
            }
        } else {
            const hits = style === 'block1' ? [0] : [0, 2];
            for (const beatIndex of hits) {
                for (const semi of tones) {
                    this._playNote(this.accompBus, t0 + beatIndex * beatSec, noteHz(semi),
                        beatSec * 0.5, 'pulse12', gain * 0.8, { pluck: true });
                }
            }
        }
    }

    _playNote(bus, t, hz, dur, timbre, gain, { vibrato = false, staccato = 0.92, pluck = false } = {}) {
        const ctx = this.engine.context;
        if (!ctx || !bus) return;
        if (t < ctx.currentTime) {
            if (t < ctx.currentTime - 0.35) return;
            t = ctx.currentTime + 0.005;
        }
        const osc = ctx.createOscillator();
        const env = ctx.createGain();

        if (this._waves?.[timbre]) osc.setPeriodicWave(this._waves[timbre]);
        else osc.type = timbre;
        osc.frequency.value = hz;

        const sounding = Math.max(0.05, dur * staccato);
        env.gain.setValueAtTime(MIN_GAIN, t);
        if (pluck) {
            env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
            env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + sounding);
        } else {
            env.gain.exponentialRampToValueAtTime(gain, t + 0.015);
            env.gain.setValueAtTime(gain, t + Math.max(0.02, sounding - 0.07));
            env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + sounding);
        }

        const extras = [];
        if (vibrato && sounding > 0.5) {
            const lfo = ctx.createOscillator();
            const depth = ctx.createGain();
            lfo.type = 'sine';
            lfo.frequency.value = 5.2;
            depth.gain.setValueAtTime(0, t);
            depth.gain.linearRampToValueAtTime(9, t + 0.35); // cents
            lfo.connect(depth).connect(osc.detune);
            lfo.start(t);
            lfo.stop(t + sounding + 0.1);
            extras.push(lfo, depth);
        }

        osc.connect(env).connect(bus);
        osc.start(t);
        osc.stop(t + sounding + 0.08);
        this._songSources.add(osc);
        osc.onended = () => {
            this._songSources.delete(osc);
            try {
                osc.disconnect();
                env.disconnect();
                for (const node of extras) node.disconnect();
            } catch { /* gone */ }
        };
    }

    stop() {
        const now = this.engine.now();
        for (const osc of this._songSources) {
            try { osc.stop(now + 0.3); } catch { /* already stopped */ }
        }
        this._songSources.clear();
        this._plan = null;
        this.nowPlaying = null;
        super.stop();
    }
}
