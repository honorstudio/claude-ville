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
