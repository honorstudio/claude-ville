// Continuous BGM sequencer. Unlike the ambient MusicLayer (sparse songs
// with long rests), this player never stops: it precomputes a piece's full
// event list, schedules it in 4-bar chunks chained on the audio clock (so
// loops are gap-free), repeats each piece 2–3 times, then takes one short
// breath and moves to the next tune in the time-of-day playlist — like
// walking into the next town.
//
// Voices per piece: pulse lead (or music-box bell at night), a counter
// voice (written inner line, constant eighth-note arpeggios, or soft pad
// chords), triangle bass, and optional whisper-level noise percussion.

import { BaseLayer } from '../layers/BaseLayer.js';
import { MIN_GAIN, pick } from '../AudioEngine.js';
import { noteHz } from '../MusicalScale.js';
import { PIECES, CHORDS, PLAYLISTS } from './BgmSongbook.js';

const BEATS_PER_BAR = 4;
const CHUNK_BEATS = 16; // 4 bars per scheduling chunk
const PIECE_GAP_MS = 1400; // one breath between tunes
const GAINS = {
    lead: 0.05,
    bell: 0.042,
    counter: 0.02,
    arp: 0.016,
    pad: 0.02,
    bass: 0.055,
    perc: 0.005,
};

// 5.3 — arrangement sections. Each band admits one more of the piece's already
// compiled voices: no extra oscillators, no transposition, no tempo change. A
// resting village keeps the tune and the bass; work adds the written counter
// line back, then the eighth-note engine, then the percussion.
const SECTION_VOICES = Object.freeze({
    rest: new Set(['lead', 'bell', 'bass']),
    light: new Set(['lead', 'bell', 'bass', 'counter', 'pad']),
    steady: new Set(['lead', 'bell', 'bass', 'counter', 'pad', 'arp']),
    full: new Set(['lead', 'bell', 'bass', 'counter', 'pad', 'arp', 'hat']),
});
export const BGM_SECTIONS = Object.freeze(Object.keys(SECTION_VOICES));

export class BgmPlayer extends BaseLayer {
    constructor(engine) {
        super(engine, { trim: 0.55 });
        this.phase = 'day';
        this.nowPlaying = null;
        this.section = 'steady';
        this._pendingSection = null;
        this._buses = null;
        this._delaySend = null;
        this._songSources = new Set();
        this._current = null; // { piece, events, beatSec, totalBeats, loop, loopsPlanned }
        this._lastPieceName = null;
    }

    // The section the counts asked for, waiting for the next four-bar chunk.
    get pendingSection() {
        return this._pendingSection;
    }

    // Queue an arrangement density. It lands on the next four-bar boundary, so
    // a change never cuts a bar in half.
    setSection(name) {
        if (!SECTION_VOICES[name]) return false;
        if (name === (this._pendingSection ?? this.section)) return false;
        this._pendingSection = name === this.section ? null : name;
        return this._pendingSection != null;
    }

    _voiceEnabled(voice) {
        return SECTION_VOICES[this.section]?.has(voice) !== false;
    }

    _start(ctx) {
        const mk = (cutoff) => {
            const tone = ctx.createBiquadFilter();
            tone.type = 'lowpass';
            tone.frequency.value = cutoff;
            tone.Q.value = 0.4;
            const bus = ctx.createGain();
            bus.connect(tone).connect(this.out);
            this.track(bus, tone);
            return bus;
        };
        this._buses = {
            lead: mk(2800),
            counter: mk(1800),
            bass: mk(800),
        };

        const percTone = ctx.createBiquadFilter();
        percTone.type = 'highpass';
        percTone.frequency.value = 6500;
        percTone.Q.value = 0.5;
        const percBus = ctx.createGain();
        percBus.connect(percTone).connect(this.out);
        this._buses.perc = percBus;
        this.track(percBus, percTone);

        // Echo on the lead; per-piece send level (night bells ring long).
        const delay = ctx.createDelay(1.5);
        delay.delayTime.value = 0.36;
        const feedback = ctx.createGain();
        feedback.gain.value = 0.16;
        const delayTone = ctx.createBiquadFilter();
        delayTone.type = 'lowpass';
        delayTone.frequency.value = 2000;
        delayTone.Q.value = 0.3;
        const delayReturn = ctx.createGain();
        delayReturn.gain.value = 0.13;
        this._delaySend = ctx.createGain();
        this._delaySend.gain.value = 0.15;

        this._buses.lead.connect(this._delaySend).connect(delay);
        delay.connect(delayTone).connect(feedback).connect(delay);
        delayTone.connect(delayReturn).connect(this.out);
        this.track(delay, feedback, delayTone, delayReturn, this._delaySend);

        this.timer(() => this._startPiece(ctx.currentTime + 0.2), 400);
    }

    setPhase(phase) {
        if (PLAYLISTS[phase]) this.phase = phase;
    }

    _playlist() {
        const names = PLAYLISTS[this.phase] || PLAYLISTS.day;
        return PIECES.filter(p => names.includes(p.name));
    }

    _startPiece(t0) {
        if (!this.running || !this.engine.context) return;
        const list = this._playlist();
        const candidates = list.filter(p => p.name !== this._lastPieceName);
        const piece = pick(candidates.length ? candidates : list);
        this._lastPieceName = piece.name;

        const beatSec = 60 / piece.bpm;
        this._current = {
            piece,
            beatSec,
            events: this._compileEvents(piece),
            totalBeats: piece.chords.length * BEATS_PER_BAR,
            loop: 0,
            loopsPlanned: 2 + (Math.random() < 0.4 ? 1 : 0),
        };
        this._delaySend.gain.setTargetAtTime(piece.delaySend ?? 0.15, this.engine.now(), 0.5);
        this._chunkAt(t0, 0);
    }

    // Flatten one piece into absolute-beat events for all voices.
    _compileEvents(piece) {
        const events = [];
        const pushNotes = (notes, voice) => {
            let beat = 0;
            for (const [semi, beats] of notes) {
                if (semi != null) events.push({ beat, semi, beats, voice });
                beat += beats;
            }
        };
        pushNotes(piece.melody, piece.lead === 'bell' ? 'bell' : 'lead');
        pushNotes(piece.bass, 'bass');
        if (piece.counter === 'written' && piece.counterNotes) {
            pushNotes(piece.counterNotes, 'counter');
        }

        piece.chords.forEach((entry, bar) => {
            const halves = Array.isArray(entry) ? entry : [entry, entry];
            const barBeat = bar * BEATS_PER_BAR;
            if (piece.counter === 'arp8') {
                // Constant eighth-note motion — the reference towns' engine.
                const arpPattern = [0, 1, 2, 1];
                for (let i = 0; i < 8; i++) {
                    const chord = CHORDS[halves[i < 4 ? 0 : 1]];
                    events.push({
                        beat: barBeat + i * 0.5,
                        semi: chord[arpPattern[i % 4]],
                        beats: 0.45,
                        voice: 'arp',
                    });
                }
            } else if (piece.counter === 'pad') {
                for (const semi of CHORDS[halves[0]]) {
                    events.push({ beat: barBeat, semi, beats: BEATS_PER_BAR - 0.1, voice: 'pad' });
                }
            }
            if (piece.perc === 'hat8') {
                for (let i = 0; i < 8; i++) {
                    events.push({ beat: barBeat + i * 0.5, voice: 'hat', accent: i % 2 === 0 });
                }
            } else if (piece.perc === 'ticks') {
                events.push({ beat: barBeat + 1, voice: 'hat', accent: false });
                events.push({ beat: barBeat + 3, voice: 'hat', accent: false });
            }
        });
        return events;
    }

    _chunkAt(t0, chunkStart) {
        const ctx = this.engine.context;
        const cur = this._current;
        if (!ctx || !cur || !this.running) return;

        // Four-bar boundary: the moment a queued section is allowed to change
        // the arrangement.
        if (this._pendingSection) {
            this.section = this._pendingSection;
            this._pendingSection = null;
        }

        const chunkEnd = Math.min(chunkStart + CHUNK_BEATS, cur.totalBeats);
        for (const ev of cur.events) {
            if (ev.beat < chunkStart || ev.beat >= chunkEnd) continue;
            this._playEvent(t0 + (ev.beat - chunkStart) * cur.beatSec, ev, cur);
        }
        this.nowPlaying = {
            piece: cur.piece.name,
            bar: Math.floor(chunkStart / BEATS_PER_BAR) + 1,
            bars: cur.piece.chords.length,
            loop: cur.loop + 1,
            of: cur.loopsPlanned,
            section: this.section,
        };

        // Generous lookahead: browsers clamp timers in throttled tabs to ~1 s,
        // and a late timer must never punch a hole in the music.
        const chunkDur = (chunkEnd - chunkStart) * cur.beatSec;
        const waitMs = Math.max(50, (t0 + chunkDur - ctx.currentTime - 1.75) * 1000);
        this.timer(() => {
            const endT = t0 + chunkDur;
            if (chunkEnd < cur.totalBeats) {
                this._chunkAt(endT, chunkEnd); // next chunk, gap-free
                return;
            }
            // Piece boundary. Loop seamlessly unless we're done with this
            // piece or the time-of-day playlist no longer contains it.
            cur.loop += 1;
            const playlistChanged = !this._playlist().some(p => p.name === cur.piece.name);
            if (cur.loop < cur.loopsPlanned && !playlistChanged) {
                this._chunkAt(endT, 0);
            } else {
                this._current = null;
                this.timer(() => this._startPiece(this.engine.context.currentTime + 0.1),
                    PIECE_GAP_MS);
            }
        }, waitMs);
    }

    _playEvent(t, ev, cur) {
        const ctx = this.engine.context;
        if (!ctx) return;
        // Voices the current section does not admit are never synthesised: a
        // resting village costs less than a working one.
        if (!this._voiceEnabled(ev.voice)) return;
        // A slightly late event plays "now" (one smeared onset beats a hole
        // in the music); anything later than a beat is genuinely lost.
        if (t < ctx.currentTime) {
            if (t < ctx.currentTime - 0.35) return;
            t = ctx.currentTime + 0.005;
        }
        if (ev.voice === 'hat') {
            this._hat(t, ev.accent);
            return;
        }
        const dur = ev.beats * cur.beatSec;
        switch (ev.voice) {
            case 'lead':
                this._note(this._buses.lead, t, ev.semi, dur * 0.9, 'pulse25', GAINS.lead, {
                    vibrato: ev.beats >= 2,
                });
                break;
            case 'bell':
                // Music box: sine-ish strike with a long natural decay.
                this._note(this._buses.lead, t, ev.semi + 12, Math.max(dur, 1.4), 'flute', GAINS.bell, {
                    pluckDecay: Math.max(dur, 1.4),
                });
                break;
            case 'counter':
                this._note(this._buses.counter, t, ev.semi, dur * 0.95, 'pulse12', GAINS.counter, {});
                break;
            case 'arp':
                this._note(this._buses.counter, t, ev.semi, dur, 'pulse12', GAINS.arp, {
                    pluckDecay: dur,
                });
                break;
            case 'pad':
                this._note(this._buses.counter, t, ev.semi, dur, 'triangle', GAINS.pad, {
                    slow: true,
                });
                break;
            case 'bass':
                this._note(this._buses.bass, t, ev.semi, dur * 0.92, 'triangle', GAINS.bass, {});
                break;
        }
    }

    _note(bus, t, semi, dur, timbre, gain, { vibrato = false, pluckDecay = 0, slow = false } = {}) {
        const ctx = this.engine.context;
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        const wave = this.engine.wave(timbre);
        if (wave) osc.setPeriodicWave(wave);
        else osc.type = timbre;
        osc.frequency.value = noteHz(semi);

        env.gain.setValueAtTime(MIN_GAIN, t);
        if (pluckDecay > 0) {
            env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
            env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + pluckDecay);
        } else if (slow) {
            env.gain.setTargetAtTime(gain, t, 0.4);
            env.gain.setTargetAtTime(MIN_GAIN, t + dur - 0.4, 0.3);
        } else {
            env.gain.exponentialRampToValueAtTime(gain, t + 0.012);
            env.gain.setValueAtTime(gain, t + Math.max(0.02, dur - 0.05));
            env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);
        }

        const extras = [];
        if (vibrato && dur > 0.6) {
            const lfo = ctx.createOscillator();
            const depth = ctx.createGain();
            lfo.type = 'sine';
            lfo.frequency.value = 5.4;
            depth.gain.setValueAtTime(0, t);
            depth.gain.linearRampToValueAtTime(8, t + 0.3);
            lfo.connect(depth).connect(osc.detune);
            lfo.start(t);
            lfo.stop(t + dur + 0.1);
            extras.push(lfo, depth);
        }

        const stopAt = t + Math.max(dur, pluckDecay) + 0.08;
        osc.connect(env).connect(bus);
        osc.start(t);
        osc.stop(stopAt);
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

    _hat(t, accent) {
        const ctx = this.engine.context;
        const src = ctx.createBufferSource();
        src.buffer = this.engine.noise('white');
        const env = ctx.createGain();
        const g = GAINS.perc * (accent ? 1.4 : 1);
        env.gain.setValueAtTime(MIN_GAIN, t);
        env.gain.exponentialRampToValueAtTime(g, t + 0.004);
        env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.035);
        src.connect(env).connect(this._buses.perc);
        src.start(t);
        src.stop(t + 0.05);
        this._songSources.add(src);
        src.onended = () => {
            this._songSources.delete(src);
            try { src.disconnect(); env.disconnect(); } catch { /* gone */ }
        };
    }

    stop() {
        const now = this.engine.now();
        for (const src of this._songSources) {
            try { src.stop(now + 0.25); } catch { /* already stopped */ }
        }
        this._songSources.clear();
        this._current = null;
        this.nowPlaying = null;
        super.stop();
    }
}
