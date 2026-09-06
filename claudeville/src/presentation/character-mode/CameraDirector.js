import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { fitAttentionFrame } from './AttentionFraming.js';

const SCORE_INTERVAL_MS = 3000;
const ORDINARY_IDLE_MS = 30000;
const USER_IDLE_MS = 45000;
const SELECTED_AGENT_GRACE_MS = 45000;
const MANUAL_EVENT_GRACE_MS = 30000;
const FOCUS_DWELL_MS = 40000;
const ORDINARY_MOVE_COOLDOWN_MS = 14000;
const GLOBAL_EVENT_COOLDOWN_MS = 15000;

const CENTRAL_RADIUS = 260;
const CENTRAL_FALLOFF_RADIUS = 360;
const FOCUS_NEIGHBOR_RADIUS = 320;
const ORDINARY_MAX_DISTANCE = 720;
const SPARSE_AGENT_LIMIT = 3;

const GROUP_BOX_PAD = 135;
const SPARSE_BOX_PAD = 170;
const LONE_AGENT_BOX_PAD = 160;

// 5.1 — Ambient broadcast pacing. Holds are measured from the moment a shot
// SETTLES, so the real gap between two moves is a hold plus the glide that
// follows it; AMBIENT_MOVE_GAP_MS is the hard floor no chapter may undercut.
const AMBIENT_HOLD_MIN_MS = 20000;
const AMBIENT_HOLD_MAX_MS = 30000;
const AMBIENT_MOVE_GAP_MS = 18000;
const AMBIENT_CHAPTERS_PER_WIDE = 2;
const AMBIENT_WIDE_PADDING_PX = 200;
const AMBIENT_COHORT_PADDING_PX = 220;
const AMBIENT_CHAPTER_PADDING_PX = 230;
// Long lateral moves, never a zoom drum: the resting tier is whatever the
// existing automatic cap allows and every ambient glide keeps it.
const AMBIENT_WIDE_GLIDE_MS = 6000;
const AMBIENT_COHORT_GLIDE_MS = 7000;
const AMBIENT_CHAPTER_GLIDE_MS = 4200;
// 5.2 — the chapter's bars stay up this long after the move settles.
const AMBIENT_CHAPTER_LETTERBOX_MS = 3000;
const AMBIENT_CHAPTER_GRADE = Object.freeze({ vignette: 0.34, worldTint: '#c0392b' });

const ORDINARY_PADDING_PX = 220;
const EVENT_PADDING_PX = Object.freeze({
    incident: 220,
    release: 250,
    arrival: 240,
    push: 250,
    default: 240,
});

const EVENT_KIND_COOLDOWN_MS = Object.freeze({
    incident: 30000,
    release: 45000,
    arrival: 60000,
    push: 60000,
    default: 45000,
});

const ACTION_WEIGHT = Object.freeze({
    [AgentStatus.ERRORED]: 18,
    [AgentStatus.RATE_LIMITED]: 17,
    [AgentStatus.WAITING_ON_USER]: 15,
    [AgentStatus.WAITING]: 11,
    [AgentStatus.WORKING]: 8,
    [AgentStatus.COMPLETED]: 1,
    [AgentStatus.IDLE]: 0,
});

function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function validBox(box) {
    return box
        && Number.isFinite(box.minX)
        && Number.isFinite(box.minY)
        && Number.isFinite(box.maxX)
        && Number.isFinite(box.maxY)
        && box.maxX >= box.minX
        && box.maxY >= box.minY;
}

function boxCenter(box) {
    return {
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
    };
}

function boxForPoints(points, pad = GROUP_BOX_PAD) {
    const finite = (points || []).filter(point => (
        Number.isFinite(point?.x) && Number.isFinite(point?.y)
    ));
    if (!finite.length) return null;
    const xs = finite.map(point => point.x);
    const ys = finite.map(point => point.y);
    return {
        minX: Math.min(...xs) - pad,
        minY: Math.min(...ys) - pad,
        maxX: Math.max(...xs) + pad,
        maxY: Math.max(...ys) + pad,
    };
}

function agentActionWeight(agent) {
    const statusWeight = ACTION_WEIGHT[agent?.status] ?? 0;
    return statusWeight
        + (agent?.currentTool ? 5 : 0)
        + (agent?.moving ? 3 : 0);
}

function valuesOfAgentSprites(agentSprites) {
    if (!agentSprites) return [];
    if (typeof agentSprites.values === 'function') return [...agentSprites.values()];
    if (Array.isArray(agentSprites)) return agentSprites;
    return [];
}

export function collectLiveAgents(agentSprites, { includePending = false } = {}) {
    const agents = [];
    for (const sprite of valuesOfAgentSprites(agentSprites)) {
        if (!sprite || sprite._archiveAnim || sprite.agent?.isDeparted || (!includePending && sprite.isArrivalPending?.())) continue;
        const source = sprite.agent;
        const id = String(source?.id || '');
        const x = finiteNumber(sprite.x);
        const y = finiteNumber(sprite.y);
        if (!id || x == null || y == null) continue;
        agents.push({
            id,
            x,
            y,
            status: source?.status || '',
            awaitingSince: source?.awaitingSince ?? null,
            currentTool: source?.currentTool || null,
            moving: Boolean(sprite.moving),
        });
    }
    return agents.sort((a, b) => a.id.localeCompare(b.id));
}

export function scoreAgentCandidates(agents) {
    const candidates = [];
    for (const agent of agents || []) {
        let nearbyCount = 0;
        let centrality = 0;

        for (const other of agents) {
            if (other.id === agent.id) continue;
            const distance = Math.hypot(other.x - agent.x, other.y - agent.y);
            if (distance <= CENTRAL_RADIUS) {
                nearbyCount += 1;
                centrality += 1 + (CENTRAL_RADIUS - distance) / CENTRAL_RADIUS * 0.6;
            } else if (distance <= CENTRAL_FALLOFF_RADIUS) {
                centrality += (CENTRAL_FALLOFF_RADIUS - distance)
                    / Math.max(1, CENTRAL_FALLOFF_RADIUS - CENTRAL_RADIUS)
                    * 0.5;
            }
        }

        const action = agentActionWeight(agent);
        const score = centrality * 10 + nearbyCount * 4 + action + 1;
        candidates.push({
            agentId: agent.id,
            x: agent.x,
            y: agent.y,
            score,
            nearbyCount,
            centrality,
            action,
        });
    }

    return candidates.sort((a, b) => (
        b.score - a.score
        || b.nearbyCount - a.nearbyCount
        || a.agentId.localeCompare(b.agentId)
    ));
}

export function selectFocus(previousFocus, candidates, now = nowMs()) {
    const top = candidates?.[0] || null;
    if (!top) return null;

    const current = previousFocus
        ? candidates.find(candidate => candidate.agentId === previousFocus.agentId)
        : null;

    if (!previousFocus || !current) {
        return focusFromCandidate(top, now);
    }

    if (top.agentId === current.agentId) {
        return {
            ...previousFocus,
            score: current.score,
            nearbyCount: current.nearbyCount,
        };
    }

    const dwellElapsed = now - (previousFocus.selectedAt ?? -Infinity);
    const hasContextGain = top.nearbyCount >= current.nearbyCount + 2;
    const hasScoreGain = top.score >= Math.max(current.score + 8, current.score * 1.3);
    if (dwellElapsed >= FOCUS_DWELL_MS || hasContextGain || hasScoreGain) {
        return focusFromCandidate(top, now);
    }

    return {
        ...previousFocus,
        score: current.score,
        nearbyCount: current.nearbyCount,
    };
}

function focusFromCandidate(candidate, now) {
    return {
        agentId: candidate.agentId,
        selectedAt: now,
        score: candidate.score,
        nearbyCount: candidate.nearbyCount,
    };
}

export function buildFocusBox(focusAgentId, agents, { includeAll = false } = {}) {
    const focus = (agents || []).find(agent => agent.id === focusAgentId) || null;
    if (!focus && !includeAll) return null;

    const points = includeAll
        ? [...(agents || [])]
        : [focus, ...(agents || []).filter(agent => (
            agent.id !== focus.id
            && Math.hypot(agent.x - focus.x, agent.y - focus.y) <= FOCUS_NEIGHBOR_RADIUS
        ))];

    if (!points.length) return null;
    const pad = includeAll
        ? SPARSE_BOX_PAD
        : points.length > 1
            ? GROUP_BOX_PAD
            : LONE_AGENT_BOX_PAD;
    return boxForPoints(points, pad);
}

// 5.1 — the wide composition: every active district in one frame. Districts
// come from the Director's work cohorts, so a district with nobody working is
// never part of the shot.
export function ambientWideBox(cohorts, pad = AMBIENT_WIDE_PADDING_PX) {
    const points = [];
    for (const cohort of cohorts || []) {
        if (!validBox(cohort?.box)) continue;
        points.push(
            { x: cohort.box.minX, y: cohort.box.minY },
            { x: cohort.box.maxX, y: cohort.box.maxY },
        );
    }
    return points.length ? boxForPoints(points, pad) : null;
}

// Which districts the wide shot promises. Returning "to the same wide" means
// returning to the saved pose while this key is unchanged.
export function ambientWideKey(cohorts) {
    return (cohorts || []).map(cohort => cohort.type).sort().join(',');
}

// Counts, never percentages, and never a fact the snapshot did not carry.
export function ambientWideCaption(cohorts) {
    let working = 0;
    let waiting = 0;
    for (const cohort of cohorts || []) {
        working += Number(cohort?.working) || 0;
        waiting += Number(cohort?.waiting) || 0;
    }
    const parts = [`Village · ${working} working`];
    if (waiting > 0) parts.push(`${waiting} waiting`);
    return parts.join(' · ');
}

export function ambientCohortCaption(cohort) {
    if (!cohort) return null;
    const parts = [`${cohort.label} · ${Number(cohort.working) || 0} working`];
    if ((Number(cohort.waiting) || 0) > 0) parts.push(`${cohort.waiting} waiting`);
    return parts.join(' · ');
}

export class CameraDirector {
    constructor(camera, { motionScale = 1 } = {}) {
        this.camera = camera;
        this.motionScale = motionScale === 0 ? 0 : 1;
        this.autoMode = true;

        this._focus = null;
        this._lastScoreAt = -Infinity;
        this._lastMoveAt = -Infinity;
        this._lastEventMoveAt = -Infinity;
        this._lastEventKindAt = new Map();
        this._latestSnapshot = null;
        // 5.1 — Ambient scheduler state. Non-null only while the explicit
        // control holds the frame; a revoked claim clears it and nothing
        // re-arms it on a timer.
        this._ambient = null;

        this._onCue = (cue) => this._handleCue(cue);
        this._unsubscribers = [
            eventBus.on('village:camera-cue', this._onCue),
        ];
    }

    setCamera(camera) {
        this.camera = camera;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    setAutoMode(on) {
        this.autoMode = Boolean(on);
        if (!this.autoMode) this._focus = null;
    }

    // C6 — enter/leave Ambient. Entry is only ever an explicit operator act:
    // this method has exactly one caller, the World's Ambient control.
    setAmbient(on) {
        const camera = this.camera;
        if (!camera?.claimOwner) return false;
        if (!on) {
            this._ambient = null;
            camera.releaseOwner('ambient');
            return false;
        }
        const claim = camera.claimOwner('ambient');
        if (!claim) return false;
        camera.stopFollow();
        this._focus = null;
        this.attentionFrame = null;
        this._ambient = {
            epoch: claim.epoch,
            phase: 'none',
            chapters: 0,
            subjectType: null,
            shotKey: '',
            caption: null,
            wide: null,
            wideKey: '',
            holdUntil: 0,
            holdExtended: false,
            lastMoveAt: -Infinity,
            settled: true,
            staticFrame: false,
            seenChapters: new Set(),
        };
        return true;
    }

    isAmbient() {
        return this.camera?.owner === 'ambient' && Boolean(this._ambient);
    }

    // The factual caption the frame renderer draws while Ambient owns the shot.
    getAmbientCaption() {
        if (!this.isAmbient()) return null;
        return this._ambient.caption || null;
    }

    frameAttention(agentSprites) {
        const camera = this.camera;
        if (!camera) return null;
        const candidates = collectLiveAgents(agentSprites, { includePending: true }).filter(agent =>
            agent.status === AgentStatus.WAITING_ON_USER
            || agent.status === AgentStatus.ERRORED
            || agent.status === AgentStatus.RATE_LIMITED);
        if (!candidates.length) {
            this.attentionFrame = null;
            return null;
        }
        // Chrome panels are flex siblings: the canvas is already the usable viewport.
        const pixelScale = camera.zoomSteps?.[0] || 1;
        const viewport = {
            width: camera._viewportWidth() / pixelScale,
            height: camera._viewportHeight() / pixelScale,
        };
        const frame = fitAttentionFrame(candidates, viewport);
        camera.noteUserInput();
        camera.glideToWorld({
            minX: frame.center.x, maxX: frame.center.x,
            minY: frame.center.y, maxY: frame.center.y,
        }, { maxZoom: frame.zoom, paddingPx: 0, duration: 700, owner: 'user', userAdjustedOnComplete: true });
        this.attentionFrame = {
            ...frame,
            focusedAgentId: frame.included[0] || frame.excluded[0],
            inputAt: camera._lastUserInputAt,
        };
        return this.attentionFrame;
    }

    dispose() {
        for (const unsubscribe of this._unsubscribers.splice(0)) {
            unsubscribe?.();
        }
        if (this._ambient) {
            this.camera?.releaseOwner?.('ambient');
            this._ambient = null;
        }
        this._focus = null;
        this.attentionFrame = null;
        this._latestSnapshot = null;
        this._lastEventKindAt.clear();
    }

    update({ now = nowMs(), agentSprites = null, snapshot = null } = {}) {
        this._latestSnapshot = snapshot || null;
        if (this.attentionFrame && this.attentionFrame.inputAt !== this.camera?._lastUserInputAt) {
            this.attentionFrame = null;
        }
        // C6 — Ambient owns the frame exclusively while its claim stands; the
        // timed Auto policy below never runs against it. A revoked claim (any
        // genuine input) drops the schedule and hands Auto back untouched.
        if (this._ambient && this.camera?.owner !== 'ambient') this._ambient = null;
        if (this._ambient) {
            this._updateAmbient(now, agentSprites, snapshot);
            return;
        }
        if (!this.autoMode || this.motionScale <= 0 || !this.camera) return;
        if (now - this._lastScoreAt < SCORE_INTERVAL_MS) return;
        if (!this._canCameraMove(now, { snapshot, ordinary: true })) return;

        this._lastScoreAt = now;
        const agents = collectLiveAgents(agentSprites);
        if (!agents.length) {
            this._focus = null;
            return;
        }

        const candidates = scoreAgentCandidates(agents);
        const nextFocus = selectFocus(this._focus, candidates, now);
        if (!nextFocus) return;
        this._focus = nextFocus;

        const includeAll = agents.length <= SPARSE_AGENT_LIMIT;
        const box = buildFocusBox(nextFocus.agentId, agents, { includeAll });
        if (!validBox(box) || this._isFrameComfortable(box)) return;
        if (now - this._lastMoveAt < ORDINARY_MOVE_COOLDOWN_MS) return;

        const distance = this._distanceFromCurrentCenter(boxCenter(box));
        if (distance > ORDINARY_MAX_DISTANCE) return;

        const options = this._ordinaryGlideOptions(distance);
        if (!this._wouldMoveEnough(box, options)) return;
        if (!this._canCameraMove(now, { snapshot, ordinary: true })) return;

        if (this.camera.glideToWorld(box, options)) {
            this._lastMoveAt = now;
            this._lastScoreAt = now;
        }
    }

    // 5.1 — the broadcast: a wide shot of the active districts, a patient
    // lateral move to the busiest real work cohort, an earned chapter, then a
    // return to the same wide. Nothing here rotates on a clock for its own
    // sake: every replacement shot has to be a different real subject, and a
    // subject that is already comfortably framed is left alone.
    _updateAmbient(now, agentSprites, snapshot) {
        const camera = this.camera;
        const state = this._ambient;
        const cohorts = (snapshot?.workCohorts || []).filter(cohort => validBox(cohort?.box));

        // Reduced motion: one static overview with the same counts, no moves.
        if (this.motionScale <= 0 || camera._reducedMotion) {
            this._ambientStaticOverview(state, cohorts, agentSprites);
            return;
        }

        if (camera.isDirectorGliding()) {
            state.settled = false;
            return;
        }
        if (!state.settled) {
            state.settled = true;
            state.holdUntil = now + AMBIENT_HOLD_MIN_MS;
            state.holdExtended = false;
            // The wide is the return address; only a wide shot may set it.
            if (state.phase === 'wide') {
                state.wide = camera.capturePose();
                state.wideEpoch = camera.inputEpoch;
            }
            return;
        }

        this._refreshAmbientCaption(state, cohorts);
        if (now - state.lastMoveAt < AMBIENT_MOVE_GAP_MS) return;

        const chapter = this._earnedAmbientChapter(snapshot, state);
        if (chapter && state.phase !== 'chapter' && state.chapters < AMBIENT_CHAPTERS_PER_WIDE) {
            if (this._startAmbientChapter(state, chapter, now)) return;
        }
        if (now < state.holdUntil) return;

        if (state.phase === 'none'
            || state.phase === 'chapter'
            || state.chapters >= AMBIENT_CHAPTERS_PER_WIDE
            || !cohorts.length) {
            this._startAmbientWide(state, cohorts, agentSprites, now);
            return;
        }
        this._startAmbientCohort(state, cohorts, now);
    }

    // Reduced motion holds exactly one composition: the overview, cut to once,
    // with live counts in the caption and no camera move ever after.
    _ambientStaticOverview(state, cohorts, agentSprites) {
        state.caption = { text: ambientWideCaption(cohorts), kind: 'wide' };
        if (state.staticFrame) return;
        const box = this._ambientWideBoxOrAgents(cohorts, agentSprites);
        if (!validBox(box)) return;
        // Under reduced motion glideToWorld cuts directly — this is the cut.
        const started = this.camera.glideToWorld(box, {
            duration: 1,
            maxZoom: this._currentMaxZoom(),
            paddingPx: AMBIENT_WIDE_PADDING_PX,
            owner: 'ambient:wide',
            composition: { x: 0.5, y: 0.55 },
            preferPan: true,
            allowZoomIn: false,
            zoomHysteresis: 1.35,
            userAdjustedOnComplete: true,
        });
        if (!started) return;
        state.staticFrame = true;
        state.phase = 'wide';
        state.chapters = 0;
        state.shotKey = `wide:${ambientWideKey(cohorts)}`;
    }

    _ambientWideBoxOrAgents(cohorts, agentSprites) {
        const box = ambientWideBox(cohorts);
        if (validBox(box)) return box;
        // No cohort is working: the honest wide is still the live village, and
        // an empty village yields no box at all, so nothing moves.
        const agents = collectLiveAgents(agentSprites);
        return agents.length ? buildFocusBox(null, agents, { includeAll: true }) : null;
    }

    // Live counts on the shot already on screen. Text only — a caption never
    // becomes a reason to move the camera.
    _refreshAmbientCaption(state, cohorts) {
        if (state.phase === 'wide') {
            state.caption = { text: ambientWideCaption(cohorts), kind: 'wide' };
            return;
        }
        if (state.phase !== 'cohort') return;
        const cohort = cohorts.find(entry => entry.type === state.subjectType);
        if (cohort) state.caption = { text: ambientCohortCaption(cohort), kind: 'cohort' };
    }

    _extendAmbientHold(state, now) {
        if (!state.holdExtended) {
            state.holdExtended = true;
            state.holdUntil = now + (AMBIENT_HOLD_MAX_MS - AMBIENT_HOLD_MIN_MS);
            return;
        }
        state.holdUntil = now + AMBIENT_HOLD_MIN_MS;
    }

    _ambientGlideOptions(owner, { duration, paddingPx, composition, grade = null, letterboxHoldMs = 0 }) {
        return {
            duration,
            // The existing automatic cap, and only resting tiers: ambient pans,
            // it does not drum the zoom.
            maxZoom: this._currentMaxZoom(),
            paddingPx,
            owner,
            composition,
            grade,
            letterboxHoldMs,
            letterbox: letterboxHoldMs > 0,
            preferPan: true,
            allowZoomIn: false,
            zoomHysteresis: 1.35,
            // Ambient's composition survives a relayout instead of being
            // re-framed to content behind the broadcast's back.
            userAdjustedOnComplete: true,
        };
    }

    _startAmbientWide(state, cohorts, agentSprites, now) {
        const camera = this.camera;
        const key = ambientWideKey(cohorts);
        const options = this._ambientGlideOptions('ambient:wide', {
            duration: AMBIENT_WIDE_GLIDE_MS,
            paddingPx: AMBIENT_WIDE_PADDING_PX,
            composition: { x: 0.5, y: 0.55 },
        });

        // The same wide, exactly: the saved pose, while the districts and the
        // input epoch it was composed for still stand.
        const canReturn = state.wide
            && state.wideKey === key
            && state.wideEpoch === camera.inputEpoch;
        let started = canReturn && camera.glideToPose(state.wide, {
            duration: AMBIENT_WIDE_GLIDE_MS,
            owner: 'ambient:wide',
        });

        if (!started) {
            const box = this._ambientWideBoxOrAgents(cohorts, agentSprites);
            if (!validBox(box)) {
                this._extendAmbientHold(state, now);
                return false;
            }
            if (state.phase === 'wide' && this._isFrameComfortable(box)) {
                this._extendAmbientHold(state, now);
                return false;
            }
            if (!this._wouldMoveEnough(box, options)) {
                state.phase = 'wide';
                state.chapters = 0;
                state.wideKey = key;
                state.wide = camera.capturePose();
                state.wideEpoch = camera.inputEpoch;
                state.caption = { text: ambientWideCaption(cohorts), kind: 'wide' };
                this._extendAmbientHold(state, now);
                return false;
            }
            started = camera.glideToWorld(box, options);
            if (started) {
                state.wide = null;
                state.wideKey = key;
            }
        }
        if (!started) {
            this._extendAmbientHold(state, now);
            return false;
        }
        state.phase = 'wide';
        state.chapters = 0;
        state.subjectType = null;
        state.shotKey = `wide:${key}`;
        state.caption = { text: ambientWideCaption(cohorts), kind: 'wide' };
        state.lastMoveAt = now;
        state.settled = false;
        return true;
    }

    _startAmbientCohort(state, cohorts, now) {
        // Cohorts arrive busiest-first and every one of them has live work, so
        // the broadcast never travels to an empty building to fill time.
        const candidate = cohorts.find(cohort => cohort.type !== state.subjectType) || null;
        if (!candidate) {
            this._extendAmbientHold(state, now);
            return false;
        }
        const shotKey = `cohort:${candidate.contextKey}`;
        const options = this._ambientGlideOptions('ambient:cohort', {
            duration: AMBIENT_COHORT_GLIDE_MS,
            paddingPx: AMBIENT_COHORT_PADDING_PX,
            composition: { x: 0.5, y: 0.55 },
        });
        // A comfortable frame, or the same real context as the shot already on
        // screen, is not worth a move.
        if (state.shotKey === shotKey || this._isFrameComfortable(candidate.box)) {
            this._extendAmbientHold(state, now);
            return false;
        }
        if (!this._wouldMoveEnough(candidate.box, options) || !this.camera.glideToWorld(candidate.box, options)) {
            this._extendAmbientHold(state, now);
            return false;
        }
        state.phase = 'cohort';
        state.chapters += 1;
        state.subjectType = candidate.type;
        state.shotKey = shotKey;
        state.caption = { text: ambientCohortCaption(candidate), kind: 'cohort' };
        state.lastMoveAt = now;
        state.settled = false;
        return true;
    }

    // 5.2 — one chapter per real incident identity. Concurrent incidents reach
    // this as a single chapter carrying an exact count, so a storm cannot queue
    // a parade of shots.
    _earnedAmbientChapter(snapshot, state) {
        const chapter = snapshot?.incidentChapter;
        if (!chapter?.id || !validBox(chapter.box)) return null;
        if (state.seenChapters.has(chapter.id)) return null;
        return chapter;
    }

    _startAmbientChapter(state, chapter, now) {
        const camera = this.camera;
        state.seenChapters.add(chapter.id);
        const caption = { text: chapter.caption, kind: 'chapter', chapterId: chapter.id };

        // Save the return address before leaving it: pose plus input epoch.
        if (!state.wide || state.wideEpoch !== camera.inputEpoch) {
            state.wide = camera.capturePose();
            state.wideEpoch = camera.inputEpoch;
        }

        const options = this._ambientGlideOptions('ambient:chapter', {
            duration: AMBIENT_CHAPTER_GLIDE_MS,
            paddingPx: AMBIENT_CHAPTER_PADDING_PX,
            composition: { x: 0.5, y: 0.53 },
            grade: AMBIENT_CHAPTER_GRADE,
            letterboxHoldMs: AMBIENT_CHAPTER_LETTERBOX_MS,
        });
        // Already in frame: the chapter is its caption, not a pointless move.
        if (this._isFrameComfortable(chapter.box, { event: true })
            || !this._wouldMoveEnough(chapter.box, options)
            || !camera.glideToWorld(chapter.box, options)) {
            state.caption = caption;
            this._extendAmbientHold(state, now);
            return false;
        }
        state.phase = 'chapter';
        state.chapters += 1;
        state.subjectType = null;
        state.shotKey = `chapter:${chapter.id}`;
        state.caption = caption;
        state.lastMoveAt = now;
        state.settled = false;
        return true;
    }

    _handleCue(cue) {
        // Honor motionScale like update() does: without this guard event cues
        // slipped through under reduced motion and hard-cut the camera
        // (glideToWorld cuts directly when the camera has reduced motion on).
        // The static fallback for an event reframe is no move at all.
        if (!this.autoMode || this.motionScale <= 0 || !this.camera || !cue || !validBox(cue.box)) return;
        const now = nowMs();
        const kind = String(cue.kind || 'default');
        // Attention cohorts inform edge cues; only the explicit A command frames them.
        if (kind === 'incident') return;
        // C6 — Ambient composes its own chapters from the Director snapshot;
        // the timed cue policy must not glide underneath it.
        if (this.camera.owner === 'ambient') return;
        if (!this._canCameraMove(now, { snapshot: this._latestSnapshot, event: true })) return;
        if (now - this._lastEventMoveAt < GLOBAL_EVENT_COOLDOWN_MS) return;

        const kindCooldown = EVENT_KIND_COOLDOWN_MS[kind] || EVENT_KIND_COOLDOWN_MS.default;
        if (now - (this._lastEventKindAt.get(kind) ?? -Infinity) < kindCooldown) return;
        if (this._isFrameComfortable(cue.box, { event: true })) return;

        const distance = this._distanceFromCurrentCenter(boxCenter(cue.box));
        const options = this._eventGlideOptions(kind, distance, cue.grade || null);
        if (!this._wouldMoveEnough(cue.box, options)) return;
        if (!this._canCameraMove(now, { snapshot: this._latestSnapshot, event: true })) return;

        if (this.camera.glideToWorld(cue.box, options)) {
            this._focus = null;
            this._lastMoveAt = now;
            this._lastScoreAt = now;
            this._lastEventMoveAt = now;
            this._lastEventKindAt.set(kind, now);
        }
    }

    _canCameraMove(now, { snapshot = null, ordinary = false, event = false } = {}) {
        const camera = this.camera;
        if (!camera) return false;
        if (this.attentionFrame?.inputAt === camera._lastUserInputAt) return false;
        if (
            camera.followTarget
            || camera.dragging
            || camera._momentum
            || camera._zoomAnimation
            || camera._snapZoom
            || camera.isDirectorGliding?.()
        ) return false;

        const idleFor = camera.getUserIdleMs ? camera.getUserIdleMs(now) : Infinity;
        if (snapshot?.selectedAgentId && idleFor < SELECTED_AGENT_GRACE_MS) return false;

        if (event) {
            return camera._cameraOwner !== 'user' || idleFor >= MANUAL_EVENT_GRACE_MS;
        }

        if (ordinary) {
            const requiredIdle = camera._cameraOwner === 'user' ? USER_IDLE_MS : ORDINARY_IDLE_MS;
            return idleFor >= requiredIdle;
        }

        return true;
    }

    _ordinaryGlideOptions(distance) {
        return {
            duration: distance > 560 ? 6500 : distance > 320 ? 5500 : 4500,
            maxZoom: this._currentMaxZoom(),
            paddingPx: ORDINARY_PADDING_PX,
            owner: 'idle-auto',
            composition: { x: 0.5, y: 0.55 },
            preferPan: true,
            allowZoomIn: false,
            zoomHysteresis: 1.35,
        };
    }

    _eventGlideOptions(kind, distance, grade) {
        return {
            duration: distance > 720 ? 7000 : distance > 420 ? 5600 : 3800,
            maxZoom: this._currentMaxZoom(),
            paddingPx: EVENT_PADDING_PX[kind] || EVENT_PADDING_PX.default,
            grade,
            owner: `cue:${kind}`,
            composition: { x: 0.5, y: kind === 'release' ? 0.56 : 0.53 },
            preferPan: true,
            allowZoomIn: false,
            zoomHysteresis: 1.35,
        };
    }

    _currentMaxZoom() {
        const camera = this.camera;
        if (typeof camera?.currentZoomTier === 'function') return Math.min(1.5, camera.currentZoomTier());
        const minZoom = camera?.minZoom || 1;
        const maxZoom = Math.min(1.5, camera?.maxZoom || 3);
        const zoom = Number(camera?.zoom);
        return Math.max(minZoom, Math.min(maxZoom, Number.isFinite(zoom) ? zoom : minZoom));
    }

    _distanceFromCurrentCenter(point) {
        const current = this.camera?.currentCenterWorld?.();
        if (!current || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return 0;
        return Math.hypot(point.x - current.x, point.y - current.y);
    }

    _wouldMoveEnough(box, options) {
        const camera = this.camera;
        const pose = camera?._poseForWorldBox?.(box, options);
        if (!pose) return true;
        const zoom = Math.max(0.1, Number(camera.zoom) || 1);
        const screenDistance = Math.hypot(pose.x - camera.x, pose.y - camera.y) * zoom;
        const zoomDistance = Math.abs((pose.zoom || zoom) - zoom);
        return screenDistance >= 120 || zoomDistance >= 0.05;
    }

    _isFrameComfortable(box, { event = false } = {}) {
        const camera = this.camera;
        const w = camera?._viewportWidth?.() || camera?.canvas?.clientWidth || 0;
        const h = camera?._viewportHeight?.() || camera?.canvas?.clientHeight || 0;
        if (!camera?.worldToScreen || !w || !h || !validBox(box)) return false;

        const corners = [
            camera.worldToScreen(box.minX, box.minY),
            camera.worldToScreen(box.maxX, box.minY),
            camera.worldToScreen(box.maxX, box.maxY),
            camera.worldToScreen(box.minX, box.maxY),
        ];
        const xs = corners.map(point => point.x);
        const ys = corners.map(point => point.y);
        const margin = event
            ? Math.max(80, Math.min(160, Math.min(w, h) * 0.10))
            : Math.max(110, Math.min(190, Math.min(w, h) * 0.13));
        const visible = Math.min(...xs) >= margin
            && Math.max(...xs) <= w - margin
            && Math.min(...ys) >= margin
            && Math.max(...ys) <= h - margin;

        const center = boxCenter(box);
        const screenCenter = camera.worldToScreen(center.x, center.y);
        const anchorX = 0.5;
        const anchorY = event ? 0.53 : 0.55;
        const deadzoneX = w * (event ? 0.22 : 0.18);
        const deadzoneY = h * (event ? 0.22 : 0.18);
        const centered = Math.abs(screenCenter.x - w * anchorX) <= deadzoneX
            && Math.abs(screenCenter.y - h * anchorY) <= deadzoneY;

        return visible && centered;
    }
}
