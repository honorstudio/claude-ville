import { normalizeBuildingType } from '../../config/buildings.js';
import { BUILDING_EVENTS, eventBus } from '../../domain/events/DomainEvent.js';
import { AgentBiography } from '../../domain/value-objects/AgentBiography.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { buildingCenterToWorld } from './Projection.js';
import { shortProjectName } from '../shared/Formatters.js';
import {
    replaySampleLookup,
    resolveWorkScoreGeometry,
    workScoreWorldBox,
    WORK_SCORE_REQUEST_EVENT,
    WORK_SCORE_STATE_EVENT,
} from './SpatialWorkScore.js';

const SCENE_LIMIT = 8;
const OVERFLOW_BUCKET_MS = 1_000;
const TOOL_EVENT_LIMIT = 40;
const REPLAY_RETENTION_MS = 60_000;
const REPLAY_SAMPLE_INTERVAL_MS = 750;
const SNAPSHOT_EMIT_INTERVAL_MS = 650;
const BUILDING_SIGNAL_TTL_MS = 45_000;
const SOCIAL_TTL_MS = 14_000;
const INCIDENT_TTL_MS = 18_000;
const RELEASE_TTL_MS = 26_000;
// 5.2 — how long a reported push failure can still earn a chapter. Matches the
// harbor's own failure summary window (SCREEN_SUMMARY_MS + FINALE_EFFECT_MS),
// so the camera and the harbor chrome talk about the same recent failures.
const PUSH_FAILURE_WINDOW_MS = 25_000;
const BIOGRAPHY_BANNER_TTL_MS = 9_000;
const LIFE_TTL_MS = 12_000;
// #40 — how long a recovery relief cue stays on the snapshot so the overlay
// can fire one straighten-and-spark beat per healed incident.
const RECOVERY_TTL_MS = 2_400;
const MAX_REPLAY_AGENTS = 72;
const MAX_SELECTED_ROUTES = 9;
const MAX_HOVER_ROUTES = 3;

function clamp(value, min = 0, max = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

function displayName(agent) {
    return agent?.agentName
        || agent?.name
        || agent?.displayName
        || agent?.agentId
        || agent?.id
        || 'Agent';
}

function compactToolName(tool) {
    const text = String(tool || '').trim();
    if (!text) return '';
    const parts = text.split(/[.:/]/).filter(Boolean);
    return (parts.at(-1) || text).replace(/_/g, ' ').slice(0, 28);
}

function agentBuilding(agent) {
    return normalizeBuildingType(
        agent?.targetBuildingType
        || agent?.lastKnownBuildingType
        || agent?.buildingType
        || agent?.building,
    );
}

function sceneId(prefix, payload = {}) {
    return `${prefix}:${payload.agentId || payload.parentId || payload.childId || payload.building || payload.kind || 'scene'}:${payload.ts || Date.now()}`;
}

function sceneProgress(scene, now) {
    if (!scene) return 1;
    const start = scene.startedAt || scene.ts || now;
    const end = scene.expiresAt || (start + 1);
    return clamp((now - start) / Math.max(1, end - start));
}

function isIncidentStatus(status) {
    return status === AgentStatus.RATE_LIMITED
        || status === AgentStatus.WAITING_ON_USER
        || status === AgentStatus.ERRORED;
}

function incidentLabel(status) {
    if (status === AgentStatus.WAITING_ON_USER) return 'Bell waiting';
    if (status === AgentStatus.RATE_LIMITED) return 'Rate limited';
    if (status === AgentStatus.ERRORED) return 'Error';
    return String(status || 'Incident').replace(/_/g, ' ');
}

// 5.1 — a cohort reads as its place: the authored short label, title-cased so
// a caption is a sentence ("Forge · 4 working"), never a shout.
function cohortLabel(building, type) {
    const raw = String(building?.shortLabel || building?.label || type || '').trim();
    if (!raw) return 'Village';
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

// 5.2 — coalesced incidents keep an exact count, never a vague plural.
function chapterCaption(text, count) {
    return count > 1 ? `${text} · ${count} incidents` : text;
}

export class VillageDirector {
    constructor(world) {
        this.world = world;
        this.motionScale = 1;
        this.selectedBuilding = null;
        this.hoveredBuilding = null;
        this.quotaState = null;
        this.harborState = null;
        this.replayActive = false;
        this.replaySamples = [];
        // 5.4 — the panel's frozen score request and the camera handle taken
        // while it is open. Both are presentation state with no world writes.
        this.workScoreRequest = null;
        this._workScoreClaim = null;
        this.toolEvents = [];
        this.scenes = [];
        // #40 — agents currently storming the watchtower (errored / rate-limited),
        // and short-lived relief cues for ones that just recovered. Keyed by id.
        this._distressedAgents = new Map();
        this._recoveries = new Map();
        this.buildingPresence = new Map();
        this.lastSnapshot = this._emptySnapshot(Date.now());
        this._lastStats = this._emptyStats();
        this._sceneOverflowCount = 0;
        // Scenes beyond the visual budget are reduced to expiry/type cohorts.
        // This preserves an exact count without retaining another render list.
        this._sceneOverflowBuckets = new Map();
        // Biography rewards share the release-parade stage, one batch at a
        // time. The queue is not render state and never bypasses SCENE_LIMIT.
        this._pendingBiographyBanners = [];
        this._seenBiographyMilestones = new Set();
        this._lastReplaySampleAt = 0;
        this._lastSnapshotEmitAt = 0;
        this._lastSceneSignatures = new Set();
        this._unsubscribers = [
            eventBus.on('agent:added', (agent) => this._onAgentAdded(agent)),
            eventBus.on('agent:updated', (agent) => this._onAgentUpdated(agent)),
            eventBus.on('agent:removed', (agent) => this._onAgentRemoved(agent)),
            eventBus.on('tool:invoked', (event) => this._onToolInvoked(event)),
            eventBus.on('subagent:dispatched', (event) => this._onSubagentDispatched(event)),
            eventBus.on('subagent:completed', (event) => this._onSubagentCompleted(event)),
            eventBus.on('team:joined', (event) => this._onTeamJoined(event)),
            eventBus.on('chat:started', (event) => this._onChatStarted(event)),
            eventBus.on('quota:throttled', (event) => this._onQuotaThrottled(event)),
            eventBus.on('harbor:updated', (repos) => this._onHarborUpdated(repos)),
            eventBus.on('harbor:release-burst', (event) => this.triggerReleaseParade(event)),
            eventBus.on('chronicle:milestone', (event) => {
                if (event?.kind === 'release') this.triggerReleaseParade(event);
            }),
            eventBus.on('biography:updated', (event) => this._onBiographyUpdated(event)),
            eventBus.on(BUILDING_EVENTS.SELECTED, (building) => this.setSelectedBuilding(building)),
            eventBus.on(BUILDING_EVENTS.DESELECTED, () => this.setSelectedBuilding(null)),
            eventBus.on(BUILDING_EVENTS.ACTIVE_AGENTS, (payload) => this._onBuildingPresence(payload)),
            eventBus.on(WORK_SCORE_REQUEST_EVENT, (request) => this.setWorkScoreRequest(request)),
        ];
    }

    dispose() {
        for (const off of this._unsubscribers) off?.();
        this._unsubscribers = [];
        this.replaySamples = [];
        this.toolEvents = [];
        this.scenes = [];
        this._sceneOverflowBuckets.clear();
        this._pendingBiographyBanners = [];
        this._seenBiographyMilestones.clear();
        this._distressedAgents.clear();
        this._recoveries.clear();
        this.buildingPresence.clear();
        this.hoveredBuilding = null;
        this.workScoreRequest = null;
        this._workScoreClaim = null;
        this._lastCueSignatures?.clear?.();
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    setQuotaState(state) {
        const quota = state?.quota || state || null;
        this.quotaState = quota;
        const ratio = this._quotaRatio(quota);
        if (ratio >= 0.86) {
            this._addScene({
                type: 'incident',
                kind: 'quota',
                building: 'mine',
                label: ratio >= 0.95 ? 'Quota storm' : 'Quota watch',
                intensity: clamp((ratio - 0.78) / 0.22),
                startedAt: Date.now(),
                expiresAt: Date.now() + INCIDENT_TTL_MS,
            });
        }
    }

    setHarborState(state = null) {
        const active = Boolean(state?.hasFailedPush || state?.status === 'failed');
        this.harborState = state || null;
        if (!active) return;
        this._addScene({
            type: 'incident',
            kind: 'failed-push',
            building: 'watchtower',
            label: 'Push failed',
            intensity: clamp(state?.intensity ?? 0.8),
            startedAt: Date.now(),
            expiresAt: Date.now() + INCIDENT_TTL_MS,
        });
    }

    setSelectedBuilding(building) {
        this.selectedBuilding = building || null;
        if (building?.type) {
            this._touchBuildingSignal(building.type, {
                reason: 'selected',
                label: 'Inspected',
                intensity: 0.55,
            });
        }
    }

    setHoveredBuilding(building) {
        this.hoveredBuilding = building || null;
    }

    setReplayActive(active) {
        const next = Boolean(active);
        if (this.replayActive === next) return this.replayActive;
        this.replayActive = next;
        eventBus.emit('village:replay', {
            active: this.replayActive,
            ts: Date.now(),
        });
        return this.replayActive;
    }

    toggleReplay() {
        return this.setReplayActive(!this.replayActive);
    }

    // 5.4 — the spatial work score. The Activity Panel owns the frozen row
    // copy, the scrub cursor and the playback timer; the director owns only
    // presentation: it resolves world anchors for the frozen nodes, holds the
    // explicit `replay` camera claim, and publishes the resolved diagram on
    // the snapshot. Nothing here writes world, domain, or simulator state, so
    // scrubbing cannot change an agent's status.
    setWorkScoreRequest(request = {}) {
        const score = request?.score?.nodes?.length ? request.score : null;
        if (!request?.active || !score) {
            this.workScoreRequest = null;
            return null;
        }
        const cursorAt = Number(request.cursorAt);
        this.workScoreRequest = {
            score,
            cursorAt: Number.isFinite(cursorAt) ? cursorAt : score.startAt,
            playing: Boolean(request.playing),
        };
        return this.workScoreRequest;
    }

    // Recorded positions come only from the retained replay minute. Nodes
    // older than that have no physical position and fall back to their
    // semantic building anchor, which the badge counts separately.
    replayPositionFor(agentId, at) {
        return replaySampleLookup(this.replaySamples, agentId, at);
    }

    // The score's semantic anchor is the building's forecourt, not its centre:
    // ground cues are occluded by the building sprite, so a glyph placed under
    // the roof would be a diagram nobody can read.
    _buildingAnchor(type) {
        const building = this._buildingFor(type);
        if (!building) return null;
        const center = buildingCenterToWorld(building);
        const footprint = ((building.width ?? 1) + (building.height ?? 1)) / 2;
        return { x: center.x, y: center.y + footprint * TILE_HALF_HEIGHT + 16 };
    }

    _syncWorkScore(renderer, now) {
        const camera = renderer?.camera || null;
        const request = this.workScoreRequest;
        if (!request) {
            if (this._workScoreClaim) {
                // Leaving the score restores the frame the operator left.
                if (camera && this._workScoreClaim.pose) camera.restorePose?.(this._workScoreClaim.pose);
                camera?.releaseOwner?.('replay');
                this._workScoreClaim = null;
                eventBus.emit(WORK_SCORE_STATE_EVENT, { active: false, ts: now });
            }
            return null;
        }

        const agentId = request.score.agentId;
        const geometry = resolveWorkScoreGeometry(request.score, {
            buildingAnchor: type => this._buildingAnchor(type),
            replayPosition: node => (agentId ? this.replayPositionFor(agentId, node.at) : null),
        });

        if (!this._workScoreClaim) {
            // One explicit framing move, because the operator asked for the
            // score. Never re-taken on a timer afterwards.
            const pose = camera?.capturePose?.() || null;
            camera?.claimOwner?.('replay');
            const box = workScoreWorldBox(geometry);
            if (box) camera?.fitToWorldBox?.(box, { paddingPx: 120, maxZoom: 2 });
            this._workScoreClaim = { pose, ownerLost: false };
            eventBus.emit(WORK_SCORE_STATE_EVENT, {
                active: true,
                ts: now,
                owner: camera?.owner ?? null,
                counts: geometry?.counts || null,
            });
        } else if (!this._workScoreClaim.ownerLost && camera && (camera.owner ?? 'replay') !== 'replay') {
            // Genuine input revoked the claim. The score stays open — it is an
            // explicit mode — but playback stops and nothing re-acquires it.
            this._workScoreClaim.ownerLost = true;
            eventBus.emit(WORK_SCORE_STATE_EVENT, {
                active: true,
                ts: now,
                owner: camera.owner ?? null,
                ownerLost: true,
                counts: geometry?.counts || null,
            });
        }

        return {
            score: request.score,
            cursorAt: request.cursorAt,
            playing: request.playing,
            geometry,
            ownerLost: this._workScoreClaim?.ownerLost === true,
            cameraOwner: camera?.owner ?? null,
            signature: `${request.score.agentId}:${request.score.startAt}:${Math.round(request.cursorAt)}:${geometry?.signature || ''}`,
        };
    }

    triggerReleaseParade(payload = {}) {
        const label = payload?.label || payload?.release || payload?.targetRef || payload?.ref || payload?.version || 'Release';
        this._addScene({
            type: 'release',
            kind: 'parade',
            building: 'harbor',
            label: String(label).replace(/^refs\/tags\//, '').slice(0, 34),
            intensity: clamp(payload?.weight === 'major' ? 1 : 0.78, 0.45, 1),
            startedAt: Date.now(),
            expiresAt: Date.now() + RELEASE_TTL_MS,
        });
    }

    _onBiographyUpdated(payload = {}) {
        const identityKey = String(payload?.identityKey || '').trim();
        if (!identityKey) return;
        const earned = [];
        for (const milestone of Array.isArray(payload?.milestones) ? payload.milestones : []) {
            const id = String(milestone?.id || '').trim();
            if (!id) continue;
            const key = `${identityKey}:${id}`;
            if (this._seenBiographyMilestones.has(key)) continue;
            this._seenBiographyMilestones.add(key);
            earned.push(milestone);
        }
        if (!earned.length) return;

        const agent = this._agentForBiography(identityKey);
        const nickname = [...earned].reverse().find(entry => entry?.nickname)?.nickname;
        const featured = nickname
            ? String(nickname)
            : String(earned.at(-1)?.label || 'Milestone earned');
        const name = agent ? displayName(agent) : this._nameFromIdentityKey(identityKey);
        this._pendingBiographyBanners.push({
            identityKey,
            milestoneIds: earned.map(entry => String(entry.id)),
            agentId: agent?.id || null,
            building: agentBuilding(agent) || 'command',
            label: `${name} · ${featured}`.slice(0, 42),
        });
    }

    _agentForBiography(identityKey) {
        const agents = this.world?.agents?.values ? this.world.agents.values() : [];
        for (const agent of agents) {
            if (AgentBiography.identityKeyFor(agent) === identityKey) return agent;
        }
        return null;
    }

    _nameFromIdentityKey(identityKey) {
        const value = String(identityKey || '').split(':').at(-1) || 'Villager';
        return value.split('-').filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ') || 'Villager';
    }

    _stageNextBiographyBanner(now) {
        if (!this._pendingBiographyBanners.length || this.scenes.length >= SCENE_LIMIT) return;
        if (this.scenes.some(scene => scene.type === 'release')) return;
        const banner = this._pendingBiographyBanners.shift();
        this._addScene({
            ...banner,
            type: 'release',
            kind: 'biography-banner',
            intensity: 0.68,
            startedAt: now,
            expiresAt: now + BIOGRAPHY_BANNER_TTL_MS,
        });
    }

    update(renderer, dt = 16, now = Date.now()) {
        const perfNow = nowMs();
        this._sampleReplay(renderer, now);
        this._prune(now);
        this._stageNextBiographyBanner(now);
        const agents = this._agentSnapshots(renderer);
        const teams = this._teamClusters(agents, perfNow);
        const handoffs = this._handoffScenes(agents, now);
        const incidents = this._incidentScenes(agents, now);
        const recoveries = this._recoveryScenes(agents, now);
        const lifecycle = this._lifecycleScenes(agents, now);
        const buildingSignals = this._buildingSignals(agents, now);
        const selectedBuildingSignal = this._selectedBuildingSignal(agents, buildingSignals);
        const hoverBuildingSignal = this._hoverBuildingSignal(agents, buildingSignals);
        const weatherInfluence = this._weatherInfluence(agents, incidents, now);
        const releaseParade = this._releaseScene(now, agents);
        const replaySamples = this.replayActive ? this._recentReplaySamples(now) : [];
        const sceneOverflow = this._sceneOverflowSummary(now);
        // 5.1/5.2 — the two facts Ambient composes from: where real work is
        // concentrated right now, and whether an incident has earned a chapter.
        const workCohorts = this._workCohorts(agents);
        const incidentChapter = this._incidentChapter(agents, incidents, now);
        // 5.4 — the requested score, resolved against real building anchors
        // and the retained replay minute. Null whenever nobody asked.
        const workScore = this._syncWorkScore(renderer, now);

        this.lastSnapshot = {
            now,
            perfNow,
            dt,
            motionScale: this.motionScale,
            replayActive: this.replayActive,
            replaySamples,
            replayAgentCount: this._replayAgentCount(replaySamples),
            selectedAgentId: renderer?.selectedAgent?.id || null,
            attentionAgents: agents.filter(agent => isIncidentStatus(agent.status)),
            teams,
            handoffs,
            incidents,
            recoveries,
            lifecycle,
            buildingSignals,
            selectedBuildingSignal,
            hoverBuildingSignal,
            releaseParade,
            weatherInfluence,
            activeSceneCount: this.scenes.length,
            sceneOverflow,
            workCohorts,
            incidentChapter,
            workScore,
        };
        this._lastStats = this._statsForSnapshot(this.lastSnapshot);

        if (now - this._lastSnapshotEmitAt >= SNAPSHOT_EMIT_INTERVAL_MS) {
            this._lastSnapshotEmitAt = now;
            eventBus.emit('village:director', this.lastSnapshot);
            if (selectedBuildingSignal) eventBus.emit('village:building-signal', selectedBuildingSignal);
            // #21 — surface the frame-worthy moments to the CameraDirector. The
            // camera layer owns cooldowns/abort; here we only resolve targets.
            this._emitCameraCues(this.lastSnapshot, now);
        }

        return this.lastSnapshot;
    }

    getSnapshot() {
        return this.lastSnapshot;
    }

    // 5.1 — group live agents into work cohorts by the building they are at.
    // A hundred agents produce at most one cohort per building, never one shot
    // per agent, and a cohort with nobody working is not a cohort at all: the
    // broadcast never visits an empty building to fill time. `contextKey` is
    // the real-context test Ambient uses before it replaces a settled shot.
    _workCohorts(agents) {
        const groups = new Map();
        for (const agent of agents || []) {
            const type = agent.building;
            if (!type || !Number.isFinite(agent.x) || !Number.isFinite(agent.y)) continue;
            const group = groups.get(type) || {
                type,
                members: [],
                working: 0,
                waiting: 0,
                errored: 0,
                tools: new Set(),
                teams: new Set(),
            };
            group.members.push(agent);
            if (agent.status === AgentStatus.WORKING) group.working += 1;
            else if (agent.status === AgentStatus.WAITING || agent.status === AgentStatus.WAITING_ON_USER) group.waiting += 1;
            else if (agent.status === AgentStatus.ERRORED || agent.status === AgentStatus.RATE_LIMITED) group.errored += 1;
            if (agent.currentTool) group.tools.add(agent.currentTool);
            const team = agent.teamName || (agent.parentSessionId ? `parent:${agent.parentSessionId}` : null);
            if (team) group.teams.add(team);
            groups.set(type, group);
        }

        const out = [];
        for (const group of groups.values()) {
            if (group.working < 1) continue;
            const building = this._buildingFor(group.type);
            const center = building ? buildingCenterToWorld(building) : null;
            const points = center ? [...group.members, center] : group.members;
            out.push({
                id: group.type,
                type: group.type,
                label: cohortLabel(building, group.type),
                working: group.working,
                waiting: group.waiting,
                errored: group.errored,
                total: group.members.length,
                teamCount: group.teams.size,
                toolCount: group.tools.size,
                agentIds: group.members.map(agent => agent.id).sort(),
                center: center || { x: group.members[0].x, y: group.members[0].y },
                box: this._boxForPoints(points, 150),
                contextKey: [
                    group.type,
                    group.working,
                    group.waiting,
                    group.members.map(agent => `${agent.id}:${agent.status}:${agent.currentTool || ''}`).sort().join(','),
                ].join('|'),
            });
        }
        return out.sort((a, b) => (
            b.working - a.working
            || b.total - a.total
            || a.type.localeCompare(b.type)
        ));
    }

    // 5.2 — the incident chapter Ambient may earn: a real rejected/failed push
    // carried by the git payload the harbor itself reads, or a real
    // errored/rate-limited worker. Identity is stable across snapshots so one
    // failure earns one chapter, and concurrent incidents coalesce into this
    // single chapter with an exact count. Waiting agents are deliberately
    // absent: the attention frame already owns them.
    _incidentChapter(agents, incidents, now) {
        const errored = (agents || []).filter(agent => (
            (agent.status === AgentStatus.ERRORED || agent.status === AgentStatus.RATE_LIMITED)
            && Number.isFinite(agent.x)
            && Number.isFinite(agent.y)
        ));
        const pushes = this._recentPushFailures(now);
        const count = errored.length + pushes.length;
        if (!count) return null;

        const push = pushes[0] || null;
        if (push) {
            // The alert lands where the shipped failed-push scene lands.
            const scene = (incidents || []).find(entry => entry.kind === 'failed-push');
            const building = this._buildingFor(scene?.building || 'watchtower');
            const center = scene?.center || (building ? buildingCenterToWorld(building) : null);
            if (center) {
                const project = push.project ? shortProjectName(push.project, '') : '';
                const label = push.status === 'rejected' ? 'Push rejected' : 'Push failed';
                return {
                    id: `push-failure:${push.id}`,
                    kind: 'failed-push',
                    caption: chapterCaption(project ? `${label} · ${project}` : label, count),
                    count,
                    building: scene?.building || 'watchtower',
                    center,
                    box: this._boxForPoints([center], 200),
                    startedAt: push.ts || now,
                };
            }
        }

        const worst = errored.find(agent => agent.status === AgentStatus.ERRORED) || errored[0];
        if (!worst) return null;
        return {
            id: `${worst.status}:${worst.id}`,
            kind: worst.status,
            caption: chapterCaption(`${incidentLabel(worst.status)} · ${worst.name}`, count),
            count,
            building: worst.building || null,
            center: { x: worst.x, y: worst.y },
            box: this._boxForPoints([{ x: worst.x, y: worst.y }], 190),
            startedAt: now,
        };
    }

    // The real push records the harbor reads: `Agent.gitEvents` push entries
    // whose reported outcome is a failure, inside the same recency window the
    // harbor's own failure summary uses. Never an outcome the payload did not
    // state — an unknown result stays unknown and earns nothing.
    _recentPushFailures(now) {
        const source = this.world?.agents?.values ? this.world.agents.values() : [];
        const failures = new Map();
        for (const agent of source) {
            for (const event of agent?.gitEvents || []) {
                if (String(event?.type || '') !== 'push') continue;
                const status = String(
                    event.status
                    || (event.success === false ? 'failed' : event.success === true ? 'success' : 'unknown'),
                ).toLowerCase();
                if (status !== 'failed' && status !== 'rejected') continue;
                const ts = Number(event.timestamp) || 0;
                if (!ts || now - ts > PUSH_FAILURE_WINDOW_MS) continue;
                const id = String(event.id || `${event.project || ''}:${ts}`);
                if (failures.has(id)) continue;
                failures.set(id, { id, status, project: event.project || '', ts });
            }
        }
        return [...failures.values()].sort((a, b) => b.ts - a.ts);
    }

    // #21 — resolve frame-worthy moments into camera cues. We dedupe per cue
    // signature so a long-lived scene only fires once; the CameraDirector
    // applies cooldown/priority/abort. Cues carry a world box plus an
    // art-directed grade hint (vignette + worldTint) for the frame pass.
    _emitCameraCues(snapshot, now) {
        if (!snapshot) return;
        if (!this._lastCueSignatures) this._lastCueSignatures = new Map();

        // Cohort identity, not incident count: the scene list is capped at six
        // for drawing, so a seventh waiting agent — or a swap that leaves the
        // count unchanged — must still reach the camera and the edge cues.
        const cohort = (snapshot.attentionAgents || []).filter(agent => Number.isFinite(agent.x) && Number.isFinite(agent.y));
        if (cohort.length) {
            const sig = cohort
                .map(agent => `${agent.id}:${agent.status}`)
                .sort()
                .join('|');
            this._fireCue('incident', sig, now, {
                box: this._boxForPoints(cohort, 90),
                grade: { vignette: 0.42, worldTint: '#c0392b' },
            });
        } else {
            this._lastCueSignatures.delete('incident');
        }

        // Release parade: frame the harbor as a ship sets sail.
        const release = snapshot.releaseParade;
        if (release?.center && Number.isFinite(release.center.x)) {
            const sig = `release:${release.id || release.label || ''}`;
            this._fireCue('release', sig, now, {
                box: this._boxForPoints([release.center], 120),
                grade: { vignette: 0.30, worldTint: '#f5c451' },
            });
        }

        // Arrival: a gentle nudge toward the freshest new villager.
        const arrival = (snapshot.lifecycle || [])
            .filter(scene => scene.kind === 'arrival' && scene.center && (scene.progress ?? 1) < 0.5)
            .at(-1);
        if (arrival?.center && Number.isFinite(arrival.center.x)) {
            const sig = `arrival:${arrival.id || arrival.agentId || ''}`;
            this._fireCue('arrival', sig, now, {
                box: this._boxForPoints([arrival.center], 80),
                grade: { vignette: 0.22, worldTint: '#7fc7c0' },
            });
        }
    }

    _fireCue(kind, signature, now, payload) {
        const last = this._lastCueSignatures.get(kind);
        if (last === signature) return;
        this._lastCueSignatures.set(kind, signature);
        eventBus.emit('village:camera-cue', { kind, ts: now, ...payload });
    }

    _boxForPoints(points, halfExtent = 90) {
        const xs = points.map(p => p.x);
        const ys = points.map(p => p.y);
        return {
            minX: Math.min(...xs) - halfExtent,
            maxX: Math.max(...xs) + halfExtent,
            minY: Math.min(...ys) - halfExtent,
            maxY: Math.max(...ys) + halfExtent,
        };
    }

    getWeatherInfluence() {
        return this.lastSnapshot?.weatherInfluence || null;
    }

    getStats() {
        return { ...this._lastStats };
    }

    _emptySnapshot(now) {
        return {
            now,
            perfNow: nowMs(),
            dt: 16,
            motionScale: this.motionScale,
            replayActive: false,
            replaySamples: [],
            replayAgentCount: 0,
            selectedAgentId: null,
            teams: [],
            handoffs: [],
            incidents: [],
            recoveries: [],
            lifecycle: [],
            buildingSignals: [],
            selectedBuildingSignal: null,
            hoverBuildingSignal: null,
            releaseParade: null,
            weatherInfluence: null,
            activeSceneCount: 0,
            sceneOverflow: null,
            workCohorts: [],
            incidentChapter: null,
            workScore: null,
        };
    }

    _emptyStats() {
        return {
            activeScenes: 0,
            sceneDrops: 0,
            sceneOverflow: 0,
            sceneOverflowTotal: 0,
            buildingSignals: 0,
            hoverPreview: 0,
            selectedRoutes: 0,
            replaySamples: 0,
            replayPoints: 0,
            replayAgents: 0,
            replayActive: false,
            handoffs: 0,
            incidents: 0,
        };
    }

    _onAgentAdded(agent) {
        const building = agentBuilding(agent) || 'command';
        this._touchBuildingSignal(building, {
            reason: 'arrival',
            label: 'Arrived',
            intensity: 0.56,
            agentId: agent?.id,
        });
        this._addScene({
            type: 'lifecycle',
            kind: 'arrival',
            agentId: agent?.id,
            building,
            label: displayName(agent),
            startedAt: Date.now(),
            expiresAt: Date.now() + LIFE_TTL_MS,
        });
    }

    _onAgentUpdated(agent) {
        const status = String(agent?.status || '');
        const building = agentBuilding(agent) || 'command';
        if (isIncidentStatus(status)) {
            this._addScene({
                type: 'incident',
                kind: status,
                agentId: agent?.id,
                building,
                label: incidentLabel(status),
                intensity: status === AgentStatus.ERRORED ? 0.92 : 0.7,
                startedAt: Date.now(),
                expiresAt: Date.now() + INCIDENT_TTL_MS,
            });
        }
        this._trackDistressTransition(agent, status);
    }

    // #40 — error/recovery story. An agent entering ERRORED or RATE_LIMITED is
    // logged as storming the Pharos and announced via `distress:watchtower` so
    // the watchtower beam can flare; when it leaves that state we emit a relief
    // cue (consumed by the overlay's straighten-and-spark on recovery) and clear
    // the distress flag. WAITING_ON_USER is an incident but not a Pharos storm.
    _trackDistressTransition(agent, status) {
        const id = agent?.id;
        if (!id) return;
        const distressed = status === AgentStatus.ERRORED || status === AgentStatus.RATE_LIMITED;
        const was = this._distressedAgents.has(id);
        if (distressed) {
            if (!was) {
                this._distressedAgents.set(id, { kind: status, since: Date.now() });
                eventBus.emit('distress:watchtower', {
                    agentId: id,
                    kind: status,
                    label: incidentLabel(status),
                    ts: Date.now(),
                });
            }
        } else if (was) {
            this._distressedAgents.delete(id);
            this._recoveries.set(id, { recoveredAt: Date.now() });
            eventBus.emit('distress:watchtower', {
                agentId: id,
                kind: 'recovered',
                ts: Date.now(),
            });
        }
    }

    _onAgentRemoved(agent) {
        if (agent?.id) {
            this._distressedAgents.delete(agent.id);
            this._recoveries.delete(agent.id);
        }
        const building = agentBuilding(agent) || 'gate';
        this._addScene({
            type: 'lifecycle',
            kind: 'departure',
            agentId: agent?.id,
            building,
            lastTile: agent?.position || null,
            label: displayName(agent),
            startedAt: Date.now(),
            expiresAt: Date.now() + LIFE_TTL_MS,
        });
    }

    _onToolInvoked(event) {
        if (!event) return;
        const now = Date.now();
        const building = normalizeBuildingType(event.building) || 'command';
        const record = {
            ...event,
            ts: Number(event.ts) || now,
            building,
            label: event.label || compactToolName(event.tool),
        };
        this.toolEvents.push(record);
        if (this.toolEvents.length > TOOL_EVENT_LIMIT) {
            this.toolEvents.splice(0, this.toolEvents.length - TOOL_EVENT_LIMIT);
        }
        this._touchBuildingSignal(building, {
            reason: record.reason || 'tool',
            label: record.label || 'Tool',
            intensity: 0.48,
            agentId: record.agentId,
        });

        const lifecycle = record.commandLifecycle || null;
        if (lifecycle?.kind && lifecycle.kind !== 'spawn') {
            this._addScene({
                type: 'social',
                kind: 'handoff',
                agentId: record.agentId,
                targetAgentId: lifecycle.targetAgentId || null,
                targetRef: lifecycle.targetRef || null,
                building,
                label: lifecycle.kind.replace(/_/g, ' '),
                startedAt: now,
                expiresAt: now + SOCIAL_TTL_MS,
            });
        }
    }

    _onSubagentDispatched(event) {
        this._addScene({
            type: 'social',
            kind: 'summon',
            parentId: event?.parentId,
            childId: event?.childId,
            building: 'command',
            label: event?.childSubagentType || event?.childAgentName || 'Subagent',
            startedAt: Date.now(),
            expiresAt: Date.now() + SOCIAL_TTL_MS,
        });
    }

    _onSubagentCompleted(event) {
        this._addScene({
            type: 'social',
            kind: 'return',
            parentId: event?.parentId,
            childId: event?.childId,
            building: 'taskboard',
            label: 'Returned',
            startedAt: Date.now(),
            expiresAt: Date.now() + SOCIAL_TTL_MS,
        });
    }

    _onTeamJoined(event) {
        this._addScene({
            type: 'social',
            kind: 'team-huddle',
            agentId: event?.agentId,
            teamName: event?.teamName,
            building: 'command',
            label: event?.teamName || 'Team',
            startedAt: Date.now(),
            expiresAt: Date.now() + SOCIAL_TTL_MS,
        });
    }

    _onChatStarted(event) {
        this._addScene({
            type: 'social',
            kind: 'handoff',
            agentId: event?.aId,
            targetAgentId: event?.bId,
            building: 'command',
            label: 'handoff',
            startedAt: Date.now(),
            expiresAt: Date.now() + SOCIAL_TTL_MS,
        });
    }

    _onQuotaThrottled(event) {
        const ratio = Number(event?.fiveHour);
        this._addScene({
            type: 'incident',
            kind: 'quota',
            building: 'mine',
            label: 'Rate limit watch',
            intensity: clamp(ratio || 0.9),
            startedAt: Date.now(),
            expiresAt: Date.now() + INCIDENT_TTL_MS,
        });
    }

    _onHarborUpdated(repos = []) {
        const failed = Array.isArray(repos) && repos.some(repo => Number(repo?.failedPushes || 0) > 0);
        if (!failed) return;
        this._touchBuildingSignal('harbor', {
            reason: 'failed-push',
            label: 'Push failed',
            intensity: 0.9,
        });
        this._addScene({
            type: 'incident',
            kind: 'failed-push',
            building: 'watchtower',
            label: 'Harbor alert',
            intensity: 0.9,
            startedAt: Date.now(),
            expiresAt: Date.now() + INCIDENT_TTL_MS,
        });
    }

    _onBuildingPresence(payload) {
        this.buildingPresence.clear();
        for (const [type, entry] of Object.entries(payload || {})) {
            if (!entry) continue;
            this.buildingPresence.set(normalizeBuildingType(type), {
                ...entry,
                updatedAt: Date.now(),
            });
        }
    }

    _addScene(scene) {
        if (!scene) return;
        const now = Date.now();
        const normalized = {
            ...scene,
            id: scene.id || sceneId(scene.type || 'scene', scene),
            startedAt: scene.startedAt || now,
            expiresAt: scene.expiresAt || now + SOCIAL_TTL_MS,
        };
        const signature = `${normalized.type}:${normalized.kind}:${normalized.agentId || ''}:${normalized.targetAgentId || ''}:${normalized.building || ''}:${normalized.label || ''}`;
        if (this._lastSceneSignatures.has(signature)) {
            const existing = this.scenes.find(item => (
                `${item.type}:${item.kind}:${item.agentId || ''}:${item.targetAgentId || ''}:${item.building || ''}:${item.label || ''}` === signature
            ));
            if (existing) {
                existing.expiresAt = Math.max(existing.expiresAt || 0, normalized.expiresAt || 0);
                existing.intensity = Math.max(existing.intensity || 0, normalized.intensity || 0);
                return;
            }
        }
        this._lastSceneSignatures.add(signature);
        this.scenes.push(normalized);
        if (this.scenes.length > SCENE_LIMIT) {
            const overflowed = [];
            while (this.scenes.length > SCENE_LIMIT) {
                let removeAt = 0;
                for (let index = 1; index < this.scenes.length; index++) {
                    if (this._sceneSalience(this.scenes[index]) < this._sceneSalience(this.scenes[removeAt])) {
                        removeAt = index;
                    }
                }
                overflowed.push(this.scenes.splice(removeAt, 1)[0]);
            }
            for (const item of overflowed) this._summarizeOverflowScene(item, now);
        }
        eventBus.emit('village:scene', normalized);
    }

    _sceneSalience(scene) {
        if (scene?.type === 'incident') return 3;
        if (scene?.type === 'release') return 1;
        return 2;
    }

    _summarizeOverflowScene(scene, now = Date.now()) {
        const expiresAt = Number(scene?.expiresAt) || now;
        if (expiresAt <= now) return;
        const bucketExpiry = Math.ceil(expiresAt / OVERFLOW_BUCKET_MS) * OVERFLOW_BUCKET_MS;
        const type = scene?.type === 'incident' ? 'incident' : 'moment';
        const key = `${type}:${bucketExpiry}`;
        const bucket = this._sceneOverflowBuckets.get(key) || { type, expiresAt: bucketExpiry, count: 0 };
        bucket.count += 1;
        this._sceneOverflowBuckets.set(key, bucket);
        this._sceneOverflowCount += 1;
    }

    _sceneOverflowSummary(now = Date.now()) {
        let count = 0;
        let incidentCount = 0;
        let expiresAt = 0;
        for (const bucket of this._sceneOverflowBuckets.values()) {
            if (bucket.expiresAt <= now) continue;
            count += bucket.count;
            if (bucket.type === 'incident') incidentCount += bucket.count;
            expiresAt = Math.max(expiresAt, bucket.expiresAt);
        }
        if (!count) return null;
        const noun = incidentCount === count ? 'incident' : 'moment';
        return {
            count,
            incidentCount,
            label: `+${count} more ${noun}${count === 1 ? '' : 's'}`,
            expiresAt,
        };
    }

    _touchBuildingSignal(type, patch = {}) {
        const building = normalizeBuildingType(type);
        if (!building) return;
        const current = this.buildingPresence.get(building) || {};
        this.buildingPresence.set(building, {
            ...current,
            ...patch,
            tier: patch.tier || current.tier || (patch.intensity > 0.65 ? 'busy' : 'active'),
            updatedAt: Date.now(),
        });
    }

    _sampleReplay(renderer, now) {
        if (!renderer?.agentSprites?.size) return;
        if (now - this._lastReplaySampleAt < REPLAY_SAMPLE_INTERVAL_MS) return;
        this._lastReplaySampleAt = now;
        const points = [];
        for (const sprite of renderer.agentSprites.values()) {
            const agent = sprite?.agent;
            if (!agent?.id) continue;
            points.push({
                id: agent.id,
                provider: agent.provider || '',
                status: agent.status || '',
                teamName: agent.teamName || null,
                tool: compactToolName(agent.currentTool),
                x: Number(sprite.x) || 0,
                y: Number(sprite.y) || 0,
            });
            if (points.length >= MAX_REPLAY_AGENTS) break;
        }
        if (points.length) this.replaySamples.push({ ts: now, points });
        this._pruneReplay(now);
    }

    _prune(now) {
        this._pruneReplay(now);
        for (const [id, entry] of this._recoveries) {
            if (now - (entry.recoveredAt || 0) > RECOVERY_TTL_MS) this._recoveries.delete(id);
        }
        this.scenes = this.scenes.filter(scene => (scene.expiresAt || 0) > now);
        for (const [key, bucket] of this._sceneOverflowBuckets) {
            if (bucket.expiresAt <= now) this._sceneOverflowBuckets.delete(key);
        }
        this.toolEvents = this.toolEvents.filter(event => now - (Number(event.ts) || 0) <= BUILDING_SIGNAL_TTL_MS);
        for (const [type, entry] of this.buildingPresence.entries()) {
            if (now - (Number(entry.updatedAt) || 0) > BUILDING_SIGNAL_TTL_MS) this.buildingPresence.delete(type);
        }
        if (this._lastSceneSignatures.size > SCENE_LIMIT * 2) {
            this._lastSceneSignatures = new Set(this.scenes.map(scene => (
                `${scene.type}:${scene.kind}:${scene.agentId || ''}:${scene.targetAgentId || ''}:${scene.building || ''}:${scene.label || ''}`
            )));
        }
    }

    _pruneReplay(now) {
        while (this.replaySamples.length && now - this.replaySamples[0].ts > REPLAY_RETENTION_MS) {
            this.replaySamples.shift();
        }
    }

    _recentReplaySamples(now) {
        return this.replaySamples.filter(sample => now - sample.ts <= REPLAY_RETENTION_MS);
    }

    _replayAgentCount(samples = []) {
        const ids = new Set();
        for (const sample of samples) {
            for (const point of sample.points || []) {
                if (point?.id) ids.add(point.id);
            }
        }
        return ids.size;
    }

    _agentSnapshots(renderer) {
        const out = [];
        const sprites = renderer?.agentSprites?.values ? renderer.agentSprites.values() : [];
        for (const sprite of sprites) {
            const agent = sprite?.agent;
            if (!agent?.id) continue;
            out.push({
                id: agent.id,
                name: displayName(agent),
                provider: agent.provider || '',
                status: agent.status || '',
                teamName: agent.teamName || null,
                parentSessionId: agent.parentSessionId || null,
                currentTool: compactToolName(agent.currentTool),
                building: agentBuilding(agent) || null,
                x: Number(sprite.x) || 0,
                y: Number(sprite.y) || 0,
                moving: Boolean(sprite.moving),
            });
        }
        return out;
    }

    _teamClusters(agents, now) {
        const clusters = new Map();
        for (const agent of agents) {
            const key = agent.teamName || (agent.parentSessionId ? `parent:${agent.parentSessionId}` : null);
            if (!key) continue;
            const cluster = clusters.get(key) || {
                id: key,
                label: String(agent.teamName || 'Subagents').slice(0, 30),
                members: [],
                x: 0,
                y: 0,
                pulse: 0,
            };
            cluster.members.push(agent.id);
            cluster.x += agent.x;
            cluster.y += agent.y;
            clusters.set(key, cluster);
        }
        const out = [];
        for (const cluster of clusters.values()) {
            if (cluster.members.length < 2) continue;
            cluster.x /= cluster.members.length;
            cluster.y /= cluster.members.length;
            cluster.radius = 26 + Math.min(5, cluster.members.length) * 6;
            cluster.pulse = this.motionScale ? (0.5 + Math.sin(now / 420 + cluster.members.length) * 0.5) : 0.55;
            out.push(cluster);
        }
        return out.slice(0, 8);
    }

    _handoffScenes(agents, now) {
        const byId = new Map(agents.map(agent => [agent.id, agent]));
        const out = [];
        for (const scene of this.scenes) {
            if (scene.type !== 'social' || (scene.kind !== 'handoff' && scene.kind !== 'summon' && scene.kind !== 'return')) continue;
            const from = byId.get(scene.agentId || scene.parentId);
            const to = byId.get(scene.targetAgentId || scene.childId);
            if (!from && !to) continue;
            out.push({
                ...scene,
                progress: sceneProgress(scene, now),
                from: from ? { id: from.id, x: from.x, y: from.y, label: from.name } : null,
                to: to ? { id: to.id, x: to.x, y: to.y, label: to.name } : null,
            });
        }
        return out.slice(-8);
    }

    _incidentScenes(agents, now) {
        const byId = new Map(agents.map(agent => [agent.id, agent]));
        const out = [];
        const explicitKeys = new Set();
        for (const scene of this.scenes) {
            if (scene.type !== 'incident') continue;
            const agent = byId.get(scene.agentId);
            const building = this._buildingFor(scene.building);
            if (scene.agentId && scene.kind) explicitKeys.add(`${scene.agentId}:${scene.kind}`);
            out.push({
                ...scene,
                progress: sceneProgress(scene, now),
                agent: agent ? { id: agent.id, x: agent.x, y: agent.y, label: agent.name } : null,
                center: building ? buildingCenterToWorld(building) : null,
            });
        }
        for (const agent of agents) {
            if (!agent?.id || !isIncidentStatus(agent.status)) continue;
            const key = `${agent.id}:${agent.status}`;
            if (explicitKeys.has(key)) continue;
            const buildingType = agent.building || agentBuilding(agent) || 'command';
            const building = this._buildingFor(buildingType);
            const startedAt = Number(agent.lastActive || agent.lastSessionActivity || now);
            out.push({
                id: sceneId('incident-live', { agentId: agent.id, kind: agent.status, ts: startedAt }),
                type: 'incident',
                kind: agent.status,
                agentId: agent.id,
                building: buildingType,
                label: incidentLabel(agent.status),
                intensity: agent.status === AgentStatus.ERRORED ? 0.88 : 0.68,
                synthetic: true,
                startedAt,
                expiresAt: now + INCIDENT_TTL_MS,
                progress: 0.25,
                agent: { id: agent.id, x: agent.x, y: agent.y, label: agent.name },
                center: building ? buildingCenterToWorld(building) : null,
            });
        }
        return out.slice(-6);
    }

    // #40 — short-lived relief cues for agents that just left an incident
    // state. The overlay reads `progress` (0→1 over RECOVERY_TTL_MS) to fade a
    // green straighten-and-spark beat at the agent's current position.
    _recoveryScenes(agents, now) {
        if (!this._recoveries.size) return [];
        const byId = new Map(agents.map(agent => [agent.id, agent]));
        const out = [];
        for (const [id, entry] of this._recoveries) {
            const age = now - (entry.recoveredAt || now);
            if (age > RECOVERY_TTL_MS) continue;
            const agent = byId.get(id);
            if (!agent) continue;
            out.push({
                agentId: id,
                progress: clamp(age / RECOVERY_TTL_MS),
                center: { x: agent.x, y: agent.y },
            });
        }
        return out;
    }

    _lifecycleScenes(agents, now) {
        const byId = new Map(agents.map(agent => [agent.id, agent]));
        const out = [];
        for (const scene of this.scenes) {
            if (scene.type !== 'lifecycle') continue;
            const agent = byId.get(scene.agentId);
            const center = agent
                ? { x: agent.x, y: agent.y }
                : scene.lastTile
                    ? buildingCenterToWorld({ position: scene.lastTile, width: 1, height: 1 })
                    : null;
            out.push({
                ...scene,
                progress: sceneProgress(scene, now),
                center,
            });
        }
        return out.slice(-8);
    }

    _buildingSignals(agents, now) {
        const counts = new Map();
        for (const agent of agents) {
            const building = agent.building;
            if (!building) continue;
            const entry = counts.get(building) || { occupied: 0, working: 0, waiting: 0, errored: 0 };
            entry.occupied += 1;
            if (agent.status === AgentStatus.WORKING) entry.working += 1;
            else if (agent.status === AgentStatus.WAITING || agent.status === AgentStatus.WAITING_ON_USER) entry.waiting += 1;
            else if (agent.status === AgentStatus.ERRORED || agent.status === AgentStatus.RATE_LIMITED) entry.errored += 1;
            counts.set(building, entry);
        }

        const out = [];
        const types = new Set([...this.buildingPresence.keys(), ...counts.keys()]);
        for (const type of types) {
            const building = this._buildingFor(type);
            if (!building) continue;
            const presence = this.buildingPresence.get(type) || {};
            const count = counts.get(type) || {};
            const recentTools = this.toolEvents
                .filter(event => event.building === type && now - (Number(event.ts) || 0) <= 25_000)
                .slice(-4);
            const heat = clamp(
                (presence.recencyScore || 0) * 0.52
                + (count.working || 0) * 0.14
                + (count.errored || 0) * 0.22
                + recentTools.length * 0.08
                + (presence.intensity || 0) * 0.36,
                0,
                1,
            );
            if (heat <= 0.05 && !recentTools.length) continue;
            out.push({
                type,
                label: this._buildingSignalLabel(type, presence, count, recentTools),
                reason: presence.reason || recentTools.at(-1)?.reason || null,
                tier: presence.tier || (heat > 0.66 ? 'busy' : heat > 0.28 ? 'active' : 'dormant'),
                heat,
                counts: count,
                recentTools: recentTools.map(event => ({
                    agentId: event.agentId,
                    label: event.label || compactToolName(event.tool),
                    reason: event.reason || null,
                    ts: event.ts,
                })),
                center: buildingCenterToWorld(building),
                updatedAt: presence.updatedAt || now,
            });
        }
        return out.sort((a, b) => b.heat - a.heat).slice(0, 12);
    }

    _selectedBuildingSignal(agents, buildingSignals) {
        if (!this.selectedBuilding?.type) return null;
        const type = normalizeBuildingType(this.selectedBuilding.type);
        const building = this._buildingFor(type) || this.selectedBuilding;
        const center = buildingCenterToWorld(building);
        const signal = buildingSignals.find(entry => entry.type === type) || {
            type,
            label: this.selectedBuilding.shortLabel || this.selectedBuilding.label || type,
            heat: 0.35,
            counts: {},
            recentTools: [],
            center,
        };
        const routes = agents
            .filter(agent => agent.building === type)
            .slice(0, MAX_SELECTED_ROUTES)
            .map(agent => ({
                agentId: agent.id,
                label: agent.name,
                status: agent.status,
                from: { x: agent.x, y: agent.y },
                to: center,
            }));
        return {
            ...signal,
            selected: true,
            routes,
            center,
        };
    }

    _hoverBuildingSignal(agents, buildingSignals) {
        if (!this.hoveredBuilding?.type) return null;
        const type = normalizeBuildingType(this.hoveredBuilding.type);
        if (!type) return null;
        if (this.selectedBuilding?.type && normalizeBuildingType(this.selectedBuilding.type) === type) return null;
        const building = this._buildingFor(type) || this.hoveredBuilding;
        const center = buildingCenterToWorld(building);
        const signal = buildingSignals.find(entry => entry.type === type) || {
            type,
            label: this.hoveredBuilding.shortLabel || this.hoveredBuilding.label || type,
            heat: 0.22,
            counts: {},
            recentTools: [],
            center,
        };
        const routes = agents
            .filter(agent => agent.building === type)
            .slice(0, MAX_HOVER_ROUTES)
            .map(agent => ({
                agentId: agent.id,
                label: agent.name,
                status: agent.status,
                from: { x: agent.x, y: agent.y },
                to: center,
            }));
        return {
            ...signal,
            hover: true,
            heat: Math.max(0.28, Math.min(0.58, signal.heat || 0.28)),
            routes,
            center,
        };
    }

    _weatherInfluence(agents, incidents, now) {
        const total = Math.max(1, agents.length);
        const stormAgents = agents.filter(agent => (
            agent.status === AgentStatus.RATE_LIMITED
            || agent.status === AgentStatus.ERRORED
            || agent.status === AgentStatus.WAITING_ON_USER
        )).length;
        const failedPush = incidents.some(scene => scene.kind === 'failed-push') ? 0.38 : 0;
        const quota = clamp((this._quotaRatio(this.quotaState) - 0.72) / 0.28) * 0.42;
        const recentCompleted = this.scenes.filter(scene => scene.type === 'lifecycle'
            && scene.kind === 'departure'
            && now - (scene.startedAt || 0) < 25_000).length;
        const rawStorminess = clamp((stormAgents / total) * 0.55 + failedPush + quota);
        const rawClearing = clamp(rawStorminess > 0 ? 0 : recentCompleted * 0.16);
        // Bucket the floats at the source so per-frame jitter in aggregate
        // health does not thrash AtmosphereState's weather cacheKey downstream.
        const storminess = Math.round(rawStorminess * 10) / 10;
        const clearing = Math.round(rawClearing * 10) / 10;
        if (storminess <= 0.02 && clearing <= 0.02) return null;
        return { storminess, clearing };
    }

    _releaseScene(now, agents = []) {
        const scene = [...this.scenes].reverse().find(item => item.type === 'release');
        if (!scene) return null;
        const agent = scene.agentId ? agents.find(entry => entry.id === scene.agentId) : null;
        const building = this._buildingFor(scene.building || 'harbor');
        return {
            ...scene,
            progress: sceneProgress(scene, now),
            center: agent
                ? { x: agent.x, y: agent.y }
                : building ? buildingCenterToWorld(building) : null,
        };
    }

    _buildingFor(type) {
        const normalized = normalizeBuildingType(type);
        if (!normalized || !this.world?.buildings?.get) return null;
        return this.world.buildings.get(normalized) || null;
    }

    _buildingSignalLabel(type, presence, count, recentTools) {
        if (presence?.label) return presence.label;
        if ((count?.errored || 0) > 0) return 'Needs attention';
        if (type === 'mine' && this._quotaRatio(this.quotaState) >= 0.86) return 'Low reserves';
        if (type === 'watchtower' && this.harborState?.hasFailedPush) return 'Alert lit';
        if ((count?.waiting || 0) > 0) return 'Queue forming';
        if (recentTools.length) return recentTools.at(-1)?.label || 'Tool work';
        if ((count?.working || 0) > 1) return 'Busy';
        return 'Active';
    }

    _statsForSnapshot(snapshot) {
        const replayPoints = (snapshot.replaySamples || []).reduce((sum, sample) => (
            sum + (Array.isArray(sample.points) ? sample.points.length : 0)
        ), 0);
        return {
            activeScenes: snapshot.activeSceneCount || 0,
            // Compatibility for the existing diagnostic line: nothing is
            // silently dropped now. The adjacent fields expose overflow.
            sceneDrops: 0,
            sceneOverflow: snapshot.sceneOverflow?.count || 0,
            sceneOverflowTotal: this._sceneOverflowCount,
            buildingSignals: snapshot.buildingSignals?.length || 0,
            hoverPreview: snapshot.hoverBuildingSignal ? 1 : 0,
            selectedRoutes: snapshot.selectedBuildingSignal?.routes?.length || 0,
            replaySamples: snapshot.replaySamples?.length || 0,
            replayPoints,
            replayAgents: snapshot.replayAgentCount || 0,
            replayActive: Boolean(snapshot.replayActive),
            handoffs: snapshot.handoffs?.length || 0,
            incidents: snapshot.incidents?.length || 0,
        };
    }

    _quotaRatio(quota) {
        return clamp(quota?.fiveHour ?? quota?.fiveHourRatio ?? quota?.usageRatio ?? 0, 0, 1);
    }
}

// #47 — translate a `village:director` snapshot into normalized narrative
// entries for the Activity Panel chronicle ribbon. Each entry is
// `{ id, kind, label, ts }`; `id` is stable per scene so the panel can dedupe
// across the 650ms snapshot cadence. Phrasing lives here, in the director's
// own module, so the panel only buffers and renders.
function narrativeLabelPair(label) {
    const text = String(label || '').trim();
    return text || 'someone';
}

export function narrativeFeedEntries(snapshot) {
    if (!snapshot) return [];
    const out = [];

    const release = snapshot.releaseParade;
    if (release?.label) {
        out.push({
            id: release.id || `parade:${release.label}`,
            kind: 'parade',
            label: `Parade — ${narrativeLabelPair(release.label)} sets sail`,
            ts: Number(release.startedAt) || snapshot.now || Date.now(),
        });
    }

    for (const scene of snapshot.handoffs || []) {
        if (scene.kind !== 'handoff') continue;
        const from = narrativeLabelPair(scene.from?.label);
        const to = narrativeLabelPair(scene.to?.label);
        out.push({
            id: scene.id || `handoff:${scene.agentId || from}:${to}`,
            kind: 'handoff',
            label: `Handoff — ${from} → ${to}`,
            ts: Number(scene.startedAt) || snapshot.now || Date.now(),
        });
    }

    for (const scene of snapshot.incidents || []) {
        const who = narrativeLabelPair(scene.agent?.label);
        out.push({
            id: scene.id || `incident:${scene.agentId}:${scene.kind}`,
            kind: 'incident',
            label: `${incidentLabel(scene.kind)} — ${who}`,
            ts: Number(scene.startedAt) || snapshot.now || Date.now(),
        });
    }

    for (const scene of snapshot.lifecycle || []) {
        if (scene.kind !== 'arrival' && scene.kind !== 'departure') continue;
        const who = narrativeLabelPair(scene.label);
        out.push({
            id: scene.id || `${scene.kind}:${scene.agentId}`,
            kind: scene.kind,
            label: scene.kind === 'arrival' ? `Arrival — ${who}` : `Departure — ${who}`,
            ts: Number(scene.startedAt) || snapshot.now || Date.now(),
        });
    }

    return out;
}
