// Director for BGM mode: continuous town music instead of the reactive
// ambience. Music-first by design — no wind/rain/wildlife layers — with
// village event cues ringing over the score like game jingles (they duck
// the music through the engine's cue bus). Time of day picks the playlist;
// the phase comes from the renderer's atmosphere broadcast, with a pure
// local-clock fallback when the World loop is stopped.
//
// 5.3 — the score has a working section. The village's real working count
// picks an arrangement density, applied at the player's next four-bar boundary;
// music never replaces the visible counts, and a real wait is never hidden
// behind a busy section.

import { eventBus } from '../../../domain/events/DomainEvent.js';
import { bucketCounts } from '../../../domain/services/SignalLedger.js';
import { createAtmosphereSnapshot } from '../../character-mode/AtmosphereState.js';
import { CueGovernor } from './CueGovernor.js';
import { CueKit } from './cues/CueKit.js';
import { BgmPlayer } from './bgm/BgmPlayer.js';

const TICK_MS = 1000;
const ATMO_FRESH_MS = 3000;
const AGENT_CUE_DEDUPE_MS = 2500;

// Four count bands. The label beside the music control always states the exact
// counts, so the bands never have to.
const SECTION_BANDS = Object.freeze([
    Object.freeze({ section: 'rest', maxWorking: 0 }),
    Object.freeze({ section: 'light', maxWorking: 3 }),
    Object.freeze({ section: 'steady', maxWorking: 11 }),
    Object.freeze({ section: 'full', maxWorking: Infinity }),
]);
// Entering the resting section takes the same 30s quiet hold the ambient
// director already uses; every other change takes 4s, so a poll-to-poll
// flutter can never rewrite the arrangement.
const SECTION_ENTER_REST_MS = 30000;
const SECTION_CHANGE_MS = 4000;
const BGM_LEVEL = 0.9;
const BGM_DUCKED_LEVEL = 0.62;

/**
 * The counts the working section and its label are made of, from the same
 * ledger `AudioDirector._tick` reads. `waiting` counts every agent that is
 * waiting (on a person or on work); `actionable` is the subset a person has to
 * act on, which is what ducks the arrangement.
 */
export function workingSectionCounts(world) {
    const counts = bucketCounts(world);
    return {
        working: Number(counts.working) || 0,
        waiting: (Number(counts.needsYou) || 0) + (Number(counts.watchlist) || 0),
        needsYou: Number(counts.needsYou) || 0,
        watchlist: Number(counts.watchlist) || 0,
        actionable: Number(counts.actionable) || 0,
    };
}

/** The exact label beside the music control. Counts, never percentages. */
export function workingSectionLabel({ working = 0, waiting = 0 } = {}) {
    return `Working ${working} · Waiting ${waiting}`;
}

export function sectionForCounts({ working = 0, actionable = 0 } = {}) {
    const band = SECTION_BANDS.find(entry => working <= entry.maxWorking).section;
    // A real wait never hides behind a triumphant busy section.
    if (actionable > 0 && (band === 'steady' || band === 'full')) return 'light';
    return band;
}

/**
 * Pure section hysteresis: the applied section plus the one the counts want
 * next, never a fictional current state.
 */
export function updateWorkingSection(state = {}, { counts = null, now = 0 } = {}) {
    const applied = state.applied || 'steady';
    const wanted = sectionForCounts(counts || {});
    if (wanted === applied) return { applied, pending: null, pendingSince: 0 };
    const pendingSince = state.pending === wanted ? (state.pendingSince ?? now) : now;
    const holdMs = wanted === 'rest' ? SECTION_ENTER_REST_MS : SECTION_CHANGE_MS;
    if (now - pendingSince >= holdMs) return { applied: wanted, pending: null, pendingSince: 0 };
    return { applied, pending: wanted, pendingSince };
}

function cuePayload(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const agent = source.agent && typeof source.agent === 'object' ? source.agent : {};
    return {
        // Keep the original event fields (position, urgency, provider-specific
        // context, and any future additions) intact for CueKit consumers.
        ...source,
        agentId: source.agentId ?? agent.id ?? source.id ?? null,
        label: agent.name || agent.displayName || agent.agentName
            || source.agentName || source.displayName || source.name || source.label || null,
        provider: source.provider || agent.provider || null,
    };
}

export class BgmDirector {
    constructor({ engine, world = null } = {}) {
        this.engine = engine;
        this.world = world;
        this.player = null;
        this.cueKit = null;
        this.governor = new CueGovernor();
        this.running = false;
        this._interval = null;
        this._unsubscribes = [];
        this._atmosphere = null;
        this._atmosphereAt = 0;
        this._atmosphereSource = 'none';
        this._phase = 'day';
        this._lastBellHour = null;
        this._recentAgentCues = new Map();
        this._section = { applied: 'steady', pending: null, pendingSince: 0 };
        this._counts = workingSectionCounts(null);
        this._level = BGM_LEVEL;
    }

    start() {
        if (this.running || !this.engine.context) return;
        this.running = true;

        this.player = new BgmPlayer(this.engine);
        this.player.start();
        this.player.setLevel(this._level, 0.5);
        this.cueKit = new CueKit(this.engine, this.governor);

        this._subscribe();
        this._interval = setInterval(() => this._tick(), TICK_MS);
        this._tick();
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        if (this._interval) clearInterval(this._interval);
        this._interval = null;
        for (const unsubscribe of this._unsubscribes) unsubscribe();
        this._unsubscribes = [];
        this.player?.stop();
        this.player = null;
        this.cueKit = null;
        this._recentAgentCues.clear();
    }

    _subscribe() {
        const on = (event, handler) => {
            this._unsubscribes.push(eventBus.on(event, handler));
        };
        on('atmosphere:updated', (snapshot) => {
            if (!snapshot) return;
            this._atmosphere = snapshot;
            this._atmosphereAt = Date.now();
            this._atmosphereSource = 'world';
        });
        on('village:scene', (scene) => {
            if (scene?.kind === 'arrival') this.cue('arrival', cuePayload(scene));
            else if (scene?.kind === 'departure') this.cue('departure', cuePayload(scene));
        });
        on('distress:watchtower', (payload) => {
            const kind = payload?.kind;
            if (kind === 'errored' || kind === 'rate_limited') {
                this._playAgentCue('distress', cuePayload(payload));
            } else if (kind === 'recovered') {
                const details = cuePayload(payload);
                this._recentAgentCues.delete(details.agentId);
                this.cue('recovery', details);
            }
        });
        on('team:gather', (payload) => this.cue('council', {
            ...cuePayload(payload),
            teamName: payload?.teamName ?? null,
            teamSize: Array.isArray(payload?.members)
                ? payload.members.length
                : payload?.teamSize ?? payload?.size,
        }));
        on('chronicle:aurora', (payload) => this.cue('aurora', cuePayload(payload)));
        // The one cue that is about the listener rather than the world.
        on('attention:raised', payload => this._playAgentCue('summons', cuePayload(payload)));
    }

    _agentCueIsRecent(agentId) {
        if (agentId == null || agentId === '') return false;
        const recent = this._recentAgentCues.get(agentId);
        if (!recent) return false;
        if (Date.now() - recent.at >= AGENT_CUE_DEDUPE_MS) {
            this._recentAgentCues.delete(agentId);
            return false;
        }
        return true;
    }

    _playAgentCue(kind, payload) {
        const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
        if (this._agentCueIsRecent(agentId)) return false;
        const played = this.cue(kind, payload);
        if (played && agentId != null && agentId !== '') {
            this._recentAgentCues.set(agentId, { kind, at: Date.now() });
        }
        return played;
    }

    cue(kind, extra = {}) {
        if (!this.cueKit) return false;
        return this.cueKit.play(kind, { phase: this._phase, ...extra });
    }

    _currentAtmosphere() {
        if (this._atmosphere && Date.now() - this._atmosphereAt < ATMO_FRESH_MS) {
            return this._atmosphere;
        }
        this._atmosphereSource = 'local';
        return createAtmosphereSnapshot({});
    }

    _tick() {
        if (!this.running) return;
        const atmosphere = this._currentAtmosphere();
        this._phase = atmosphere.phase || 'day';
        this.player.setPhase(this._phase);
        this._applyWorkingSection();

        const clock = atmosphere.clock || {};
        if (clock.minutes === 0 && clock.hours >= 8 && clock.hours <= 20
            && this._lastBellHour !== clock.hours) {
            if (this.cue('hourBell')) this._lastBellHour = clock.hours;
        }
    }

    // The arrangement follows the counts, not the poll: the density change is
    // handed to the player, which applies it at its next four-bar boundary. The
    // one immediate move is the duck an actionable agent earns.
    _applyWorkingSection(now = Date.now()) {
        this._counts = workingSectionCounts(this.world);
        this._section = updateWorkingSection(this._section, { counts: this._counts, now });
        this.player?.setSection(this._section.applied);
        const level = this._counts.actionable > 0 ? BGM_DUCKED_LEVEL : BGM_LEVEL;
        if (level !== this._level) {
            this._level = level;
            this.player?.setLevel(level, 0.4);
        }
    }

    countsSnapshot() {
        return { ...this._counts };
    }

    snapshot() {
        return {
            running: this.running,
            phase: this._phase,
            atmosphereSource: this._atmosphereSource,
            levels: { bgm: this.player?.level ?? 0 },
            lastCue: this.cueKit?.lastCue || null,
            nowPlaying: this.player?.nowPlaying || null,
            // The section actually playing plus the one the counts want next.
            section: {
                applied: this.player?.section ?? this._section.applied,
                requested: this._section.applied,
                pending: this.player?.pendingSection ?? this._section.pending,
                counts: { ...this._counts },
                label: workingSectionLabel(this._counts),
            },
        };
    }
}
