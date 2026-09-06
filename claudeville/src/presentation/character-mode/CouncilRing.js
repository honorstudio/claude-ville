import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { THEME } from '../../config/theme.js';
import { getTeamColor } from '../shared/TeamColor.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { tileToWorld, worldToTile } from './Projection.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';
import { pulseBand01 } from './PulsePolicy.js';
import { gradeColor } from './AtmosphereState.js';
import { cueNoteDue } from '../shared/audio/CueScore.js';

const MAX_TALK_ARCS = 8;
// #27 — slow band: one full mote traversal per ~1.8s travelling along the arc.
const TALK_MOTE_PERIOD_MS = 1800;
const COMMAND_PLAZA = { tileX: 16, tileY: 21 };
const TEAM_GATHER_COOLDOWN_MS = 5 * 60 * 1000;
const TEAM_GATHER_RADIUS_TILES = 12;
// 5.3 — one gather ceremony is legible at a time: its notches land on the
// council cue's successive bells, the team mark on the final one, and the whole
// roll call clears again so the default frame keeps only the quiet outline.
const COUNCIL_CEREMONY_HOLD_MS = 8000;
const COUNCIL_NOTCH_SIZE = 4;
const COUNCIL_MARK_FONT = 'bold 7px "Press Start 2P", monospace';
// Clear of the gathered bodies: the mark sits above the huddle, not inside it.
const COUNCIL_MARK_LIFT = 96;
let _councilCeremony = null;
const _teamGatherCooldownsByOwner = new WeakMap();
const _commandPlazaVisitTiles = (BUILDING_DEFS.find(def => def.type === 'command')?.visitTiles || []).map(tile => ({ ...tile }));

function tileToScreen(tile) {
    return tileToWorld(tile);
}

function relationshipSnapshot(relationship) {
    if (!relationship) return null;
    return typeof relationship.getSnapshot === 'function' ? relationship.getSnapshot() : relationship;
}

function teamGatherCooldowns(relationship, create = true) {
    if (!relationship || (typeof relationship !== 'object' && typeof relationship !== 'function')) return null;
    let cooldowns = _teamGatherCooldownsByOwner.get(relationship);
    if (!cooldowns && create) {
        cooldowns = new Map();
        _teamGatherCooldownsByOwner.set(relationship, cooldowns);
    }
    return cooldowns;
}

export function releaseCouncilRingState(relationship) {
    if (!relationship || (typeof relationship !== 'object' && typeof relationship !== 'function')) return;
    _teamGatherCooldownsByOwner.delete(relationship);
    _councilCeremony = null;
}

export function getCouncilRingDiagnostics(relationship) {
    return {
        teamGatherCooldowns: teamGatherCooldowns(relationship, false)?.size || 0,
        cooldownMs: TEAM_GATHER_COOLDOWN_MS,
        ceremonyTeam: _councilCeremony?.teamName || null,
        ceremonyMembers: _councilCeremony?.members.length || 0,
    };
}

function rgba(hex, alpha) {
    const text = String(hex || '');
    if (!/^#[0-9a-f]{6}$/i.test(text)) return text;
    const r = parseInt(text.slice(1, 3), 16);
    const g = parseInt(text.slice(3, 5), 16);
    const b = parseInt(text.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightBoost(lighting) {
    return Math.max(0.45, Math.min(1.8, lighting?.lightBoost ?? 1));
}

function sortedSpritesForTeam(memberIds, agentSprites) {
    const sprites = [];
    for (const id of memberIds || []) {
        const sprite = agentSprites?.get?.(id);
        if (sprite && !sprite.isArrivalPending?.()) sprites.push(sprite);
    }
    return sprites.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
}

function isIdleSprite(sprite) {
    return sprite?.agent?.status === AgentStatus.IDLE;
}

export function applyTeamPlazaPreferences(relationship, agentSprites) {
    const snapshot = relationshipSnapshot(relationship);
    if (!snapshot?.teamToMembers || !agentSprites) return;

    const preferredIds = new Set();
    for (const memberIds of snapshot.teamToMembers.values()) {
        const idle = memberIds
            .map(id => agentSprites.get(id))
            .filter(isIdleSprite);
        if (idle.length < 2) continue;
        for (const sprite of idle) preferredIds.add(sprite.agent.id);
    }

    for (const sprite of agentSprites.values()) {
        sprite.setTeamPlazaPreference?.(preferredIds.has(sprite.agent?.id));
    }

    if (snapshot.parentToChildren) {
        for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
            if (!childIds || childIds.size < 2) continue;
            const parent = agentSprites.get(parentId);
            if (!parent || !isIdleSprite(parent)) continue;
            const parentTile = worldToTile(parent.x, parent.y);
            for (const childId of childIds) {
                const child = agentSprites.get(childId);
                if (!child || !isIdleSprite(child)) continue;
                if (typeof child.setFamilyPlazaPreference === 'function') {
                    child.setFamilyPlazaPreference(parentTile.tileX, parentTile.tileY);
                }
            }
        }
    }

    applyTeamGatherChoreography(relationship, agentSprites);
}

export function applyTeamGatherChoreography(snapshot, agentSprites, { now = performance.now() } = {}) {
    const data = relationshipSnapshot(snapshot);
    if (!data?.teamToMembers || !agentSprites) return;
    const cooldowns = teamGatherCooldowns(snapshot);
    const liveTeams = new Set(data.teamToMembers.keys());
    for (const teamName of cooldowns?.keys?.() || []) {
        if (!liveTeams.has(teamName)) cooldowns.delete(teamName);
    }

    for (const [teamName, memberIds] of data.teamToMembers.entries()) {
        // A team that has never gathered has no cooldown to serve. `now` is
        // `performance.now()`, so treating a missing entry as 0 held every
        // first gather back for the page's first five minutes.
        const last = cooldowns?.get(teamName);
        if (last != null && now - last < TEAM_GATHER_COOLDOWN_MS) continue;

        const idle = [];
        let blocked = false;
        for (const id of memberIds) {
            const sprite = agentSprites.get(id);
            if (!sprite) continue;
            if (sprite.agent?.status === AgentStatus.WAITING_ON_USER) { blocked = true; break; }
            if (!isIdleSprite(sprite)) continue;
            if (sprite.isArrivalPending?.()) continue;
            idle.push(sprite);
        }
        if (blocked || idle.length < 2) continue;

        let maxDist = 0;
        for (let i = 0; i < idle.length && maxDist <= TEAM_GATHER_RADIUS_TILES; i++) {
            const a = worldToTile(idle[i].x, idle[i].y);
            for (let j = i + 1; j < idle.length; j++) {
                const b = worldToTile(idle[j].x, idle[j].y);
                const d = Math.hypot(a.tileX - b.tileX, a.tileY - b.tileY);
                if (d > maxDist) maxDist = d;
                if (maxDist > TEAM_GATHER_RADIUS_TILES) break;
            }
        }
        if (maxDist > TEAM_GATHER_RADIUS_TILES) continue;

        const cx = idle.reduce((sum, s) => sum + s.x, 0) / idle.length;
        const cy = idle.reduce((sum, s) => sum + s.y, 0) / idle.length;
        const centroidTile = worldToTile(cx, cy);
        const sorted = idle
            .map(sprite => ({ sprite, angle: Math.atan2(sprite.y - cy, sprite.x - cx) }))
            .sort((a, b) => a.angle - b.angle);

        const slotCount = _commandPlazaVisitTiles.length || 1;
        const centroidArc = sorted.map((entry, index) => {
            const slotIndex = index % slotCount;
            const tile = _commandPlazaVisitTiles[slotIndex] || COMMAND_PLAZA;
            return {
                agentId: entry.sprite.agent.id,
                angle: entry.angle,
                slotIndex,
                tileX: tile.tileX,
                tileY: tile.tileY,
            };
        });

        const members = sorted.map(entry => entry.sprite.agent.id);
        cooldowns?.set(teamName, now);
        // 5.3 — the roll call this gather is about to draw. One ceremony at a
        // time: a busier village gets the same quiet outline it has today.
        _councilCeremony = { teamName, members, startedAt: now };
        eventBus.emit('team:gather', {
            teamName,
            members: [...members],
            plazaTile: { tileX: centroidTile.tileX, tileY: centroidTile.tileY },
            centroidArc,
        });
    }
}

// 5.3 — the gather roll call. One static notch per gathered member, each on the
// council cue's successive bell (members past the fifth land on the final one),
// then a static `team · N` mark stating the whole membership. Reduced motion
// and a silent village draw every mark at once: the roll call never waits on
// sound, and the count is never carried by the music alone.
//
// Drawn in the upper overlay, not the ground pass: a notch under a body is a
// notch nobody can read.
function drawGatherRollCall(ctx, {
    agentSprites,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    grade = null,
}) {
    const ceremony = _councilCeremony;
    if (!ceremony) return;
    if (now - ceremony.startedAt > COUNCIL_CEREMONY_HOLD_MS) {
        _councilCeremony = null;
        return;
    }

    const teamName = ceremony.teamName;
    const sprites = ceremony.members.map(id => agentSprites?.get?.(id) || null);
    const present = sprites.filter(Boolean);
    if (present.length < 2) return;

    const governor = getActiveMarkGovernor();
    const gate = governor
        ? governor.admit(MarkTier.SECONDARY, present[0].x, present[0].y)
        : { draw: true, alpha: 1 };
    if (!gate.draw) return;

    const total = ceremony.members.length;
    const immediate = motionScale === 0;
    const color = gradeColor(getTeamColor(teamName).accent, grade);
    ctx.save();
    const notchFill = rgba(color, Math.min(1, gate.alpha));
    const notchSeat = `rgba(20, 14, 10, ${Math.min(0.85, 0.8 * gate.alpha).toFixed(2)})`;
    for (let i = 0; i < total; i++) {
        if (!immediate && !cueNoteDue('council', teamName, i, now)) continue;
        const sprite = sprites[i];
        if (!sprite) continue;
        // At the shoes of the member the bell named. The dark seat keeps the
        // square readable over a hem, a cobble or wet grass alike.
        const left = Math.round(sprite.x) - Math.round(COUNCIL_NOTCH_SIZE / 2);
        const top = Math.round(sprite.y) + 1;
        ctx.fillStyle = notchSeat;
        ctx.fillRect(left - 1, top - 1, COUNCIL_NOTCH_SIZE + 2, COUNCIL_NOTCH_SIZE + 2);
        ctx.fillStyle = notchFill;
        ctx.fillRect(left, top, COUNCIL_NOTCH_SIZE, COUNCIL_NOTCH_SIZE);
    }

    if (immediate || cueNoteDue('council', teamName, total - 1, now)) {
        const plaza = tileToScreen(COMMAND_PLAZA);
        const centroid = present.reduce(
            (acc, sprite) => ({
                x: acc.x + sprite.x / present.length,
                y: acc.y + sprite.y / present.length,
            }),
            { x: 0, y: 0 },
        );
        const text = `${teamName} · ${total}`;
        const width = 12 + text.length * 7;
        ctx.translate(
            (centroid.x * 0.75) + (plaza.x * 0.25),
            (centroid.y * 0.75) + (plaza.y * 0.25) - COUNCIL_MARK_LIFT,
        );
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        ctx.font = COUNCIL_MARK_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(20, 14, 10, 0.85)';
        ctx.fillRect(-width / 2, -7, width, 14);
        ctx.strokeStyle = rgba(color, 0.8);
        ctx.lineWidth = 1;
        ctx.strokeRect(-width / 2, -7, width, 14);
        ctx.fillStyle = rgba(color, Math.min(1, 0.95 * gate.alpha + 0.05));
        ctx.fillText(text, 0, 0);
    }
    ctx.restore();
}

export function drawCouncilRings(ctx, {
    relationship,
    agentSprites,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    grade = null,
} = {}) {
    const snapshot = relationshipSnapshot(relationship);
    if (!ctx || !snapshot?.teamToMembers || !agentSprites) return;

    const boost = lightBoost(lighting);
    const plaza = tileToScreen(COMMAND_PLAZA);
    // 3.9 — council rings are declared STATIC in the motion budget ("no
    // pulse… council ring"); the ±16% sine shimmer is removed. Alpha is
    // modulated only by the slow-changing lighting boost, so the reduced-
    // motion rendering is identical.
    const governor = getActiveMarkGovernor();

    for (const [teamName, memberIds] of snapshot.teamToMembers.entries()) {
        const sprites = sortedSpritesForTeam(memberIds, agentSprites);
        if (sprites.length < 2) continue;

        const color = getTeamColor(teamName);
        const gate = governor
            ? governor.admit(MarkTier.SECONDARY, sprites[0].x, sprites[0].y)
            : { draw: true, alpha: 1 };
        if (!gate.draw) continue;
        ctx.save();
        ctx.strokeStyle = rgba(gradeColor(color.accent, grade), Math.min(0.42, 0.26 * boost) * gate.alpha);
        ctx.lineWidth = 1.4 / (zoom || 1);
        ctx.setLineDash([]);
        ctx.beginPath();

        const points = sprites.map(sprite => ({ x: sprite.x, y: sprite.y - 3 }));
        const centroid = points.reduce(
            (acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }),
            { x: 0, y: 0 },
        );
        const anchor = {
            x: (centroid.x * 0.75) + (plaza.x * 0.25),
            y: (centroid.y * 0.75) + (plaza.y * 0.25),
        };

        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            const next = points[(i + 1) % points.length];
            const mid = {
                x: (point.x + next.x) / 2,
                y: (point.y + next.y) / 2,
            };
            const control = {
                x: mid.x + (anchor.x - mid.x) * 0.18,
                y: mid.y + (anchor.y - mid.y) * 0.18 - 8,
            };
            if (i === 0) ctx.moveTo(point.x, point.y);
            ctx.quadraticCurveTo(control.x, control.y, next.x, next.y);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }
}

export function drawFamilyTethers(ctx, {
    relationship,
    agentSprites,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    grade = null,
    projectIsoToScreen = null, // reserved; world transform already applied by caller
} = {}) {
    void projectIsoToScreen;
    const snapshot = relationshipSnapshot(relationship);
    if (!ctx || !snapshot?.parentToChildren || !agentSprites) return;

    const boost = lightBoost(lighting);
    // 3.9 — flicker snapped onto the shared 'intrinsic' pulse band; reduced
    // motion keeps the legacy static value.
    const flicker = motionScale === 0 ? 1 : 0.85 + 0.15 * pulseBand01('intrinsic', now, motionScale);
    const alpha = Math.min(0.28, Math.max(0.18, 0.22 * boost * flicker));
    const dashOffset = motionScale === 0 ? 0 : -(Math.floor(now * 0.06) % 9);
    const governor = getActiveMarkGovernor();

    const advisorChildIds = new Set((snapshot.advisorPairs || []).map(pair => pair.advisorId));

    for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
        const parent = agentSprites.get(parentId);
        if (!parent || parent.isArrivalPending?.()) continue;
        const trim = gradeColor(parent._providerTrimColor?.() || parent.providerTrimColor || '#8b8b9e', grade);

        for (const childId of childIds) {
            // Advisor pairs get their own explicit tether pass below.
            if (advisorChildIds.has(childId)) continue;
            const child = agentSprites.get(childId);
            if (!child || child.isArrivalPending?.()) continue;

            const start = { x: parent.x, y: parent.y - 6 };
            const end = { x: child.x, y: child.y - 6 };
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 1) continue;
            const gate = governor
                ? governor.admit(MarkTier.SECONDARY, start.x, start.y)
                : { draw: true, alpha: 1 };
            if (!gate.draw) continue;
            const stroke = rgba(trim, alpha * gate.alpha);
            const control = {
                x: (start.x + end.x) / 2,
                y: (start.y + end.y) / 2 - Math.min(28, dist * 0.18),
            };

            ctx.save();
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1 / (zoom || 1);
            ctx.setLineDash([3 / (zoom || 1), 6 / (zoom || 1)]);
            ctx.lineDashOffset = dashOffset / (zoom || 1);
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
            ctx.stroke();
            ctx.restore();
        }
    }
}

/**
 * Explicit advisor link: an omp advisor thread is bound to the session it
 * counsels. Unlike the faint dashed family tethers this is a solid, brighter
 * cord in the advisor's trim colour with a mote travelling advisor → parent
 * (counsel flowing to the advisee), so the pairing reads at a glance.
 */
export function drawAdvisorTethers(ctx, {
    relationship,
    agentSprites,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    grade = null,
} = {}) {
    const snapshot = relationshipSnapshot(relationship);
    const pairs = snapshot?.advisorPairs;
    if (!ctx || !Array.isArray(pairs) || !pairs.length || !agentSprites) return;

    const boost = lightBoost(lighting);
    const pulse = motionScale === 0 ? 1 : 0.82 + 0.18 * pulseBand01('intrinsic', now, motionScale, 0.9);
    const alpha = Math.min(0.55, Math.max(0.3, 0.42 * boost * pulse));
    const governor = getActiveMarkGovernor();
    const invZoom = 1 / (zoom || 1);

    for (const pair of pairs) {
        const advisor = agentSprites.get(pair.advisorId);
        const parent = agentSprites.get(pair.parentId);
        if (!advisor || !parent) continue;
        if (advisor.isArrivalPending?.() || parent.isArrivalPending?.()) continue;

        const start = { x: advisor.x, y: advisor.y - 8 };
        const end = { x: parent.x, y: parent.y - 8 };
        const dist = Math.hypot(end.x - start.x, end.y - start.y);
        if (dist < 1) continue;
        const gate = governor
            ? governor.admit(MarkTier.SECONDARY, start.x, start.y)
            : { draw: true, alpha: 1 };
        if (!gate.draw) continue;

        const trim = gradeColor(advisor._providerTrimColor?.() || advisor.providerTrimColor || '#ffd76a', grade);
        const control = {
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2 - Math.min(34, dist * 0.22),
        };

        ctx.save();
        ctx.strokeStyle = rgba(trim, alpha * gate.alpha);
        ctx.lineWidth = 1.4 * invZoom;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
        ctx.stroke();

        // Counsel mote riding the curve toward the parent; static midpoint
        // bead under reduced motion so the link stays marked.
        const t = motionScale === 0 ? 0.5 : ((now % TALK_MOTE_PERIOD_MS) / TALK_MOTE_PERIOD_MS);
        const inv = 1 - t;
        const moteX = inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x;
        const moteY = inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y;
        ctx.fillStyle = rgba(trim, Math.min(0.85, (alpha + 0.3) * gate.alpha));
        ctx.beginPath();
        ctx.arc(moteX, moteY, 1.6 * invZoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

/**
 * Warm tethers between idle allies that the village has long paired up.
 * Unlike family tethers (which read the live relationship snapshot), this
 * takes a precomputed list of `{ a, b }` sprite pairs from the renderer's
 * affinity proximity pass, so no per-frame affinity scan happens here.
 */
export function drawAllyTethers(ctx, {
    pairs,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    grade = null,
} = {}) {
    if (!ctx || !Array.isArray(pairs) || !pairs.length) return;

    const boost = lightBoost(lighting);
    // 3.9 — pulse snapped onto the shared 'intrinsic' band (detuned from the
    // family-tether claim); reduced motion keeps the legacy static value.
    const pulse = motionScale === 0 ? 1 : 0.78 + 0.22 * pulseBand01('intrinsic', now, motionScale, 1.1);
    const alpha = Math.min(0.26, Math.max(0.16, 0.2 * boost * pulse));
    const governor = getActiveMarkGovernor();

    for (const pair of pairs) {
        const a = pair?.a;
        const b = pair?.b;
        if (!a || !b || a === b) continue;
        if (a.isArrivalPending?.() || b.isArrivalPending?.()) continue;

        const start = { x: a.x, y: a.y - 4 };
        const end = { x: b.x, y: b.y - 4 };
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) continue;
        const gate = governor
            ? governor.admit(MarkTier.SECONDARY, start.x, start.y)
            : { draw: true, alpha: 1 };
        if (!gate.draw) continue;
        const stroke = rgba(gradeColor(THEME.ally || '#f0b27a', grade), alpha * gate.alpha);
        const control = {
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2 - Math.min(22, dist * 0.16),
        };

        ctx.save();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.2 / (zoom || 1);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
        ctx.stroke();
        ctx.restore();
    }
}

function prioritizedChatPairs(pairs, agentSprites) {
    return [...(pairs || [])]
        .sort((a, b) => {
            const aTime = Math.max(
                agentSprites?.get?.(a.aId)?.agent?.lastActive || 0,
                agentSprites?.get?.(a.bId)?.agent?.lastActive || 0,
            );
            const bTime = Math.max(
                agentSprites?.get?.(b.aId)?.agent?.lastActive || 0,
                agentSprites?.get?.(b.bId)?.agent?.lastActive || 0,
            );
            return bTime - aTime;
        })
        .slice(0, MAX_TALK_ARCS);
}

// 3.9 — priority-ordered admission. Talk arcs are the highest-value SECONDARY
// marks but draw LAST (above sprites), so in draw order they were the first to
// cull in a busy region. WorldFrameRenderer calls admitTalkArcMarks() before
// the ring/tether passes; it admits the frame's talk marks up front and caches
// the gates, which drawTalkArcs() then replays instead of admitting late.
// Gates are re-admitted every frame (keyed on the governor's frame counter),
// so this is a pure admission reorder — no persistent budget, and a caller
// that skips the pre-pass gets the legacy admit-on-draw behavior.
const _talkArcGates = new Map();
let _talkArcGateFrame = -1;

export function admitTalkArcMarks({ relationship, agentSprites } = {}) {
    const governor = getActiveMarkGovernor();
    if (!governor) return;
    const snapshot = relationshipSnapshot(relationship);
    if (!snapshot || !agentSprites) return;
    if (_talkArcGateFrame === governor._frame) return;
    _talkArcGates.clear();

    for (const pair of prioritizedChatPairs(snapshot.chatPairs, agentSprites)) {
        const a = agentSprites.get(pair.aId);
        const b = agentSprites.get(pair.bId);
        if (!a || !b || a.isArrivalPending?.() || b.isArrivalPending?.()) continue;
        _talkArcGates.set(`talk:${pair.aId}:${pair.bId}`, governor.admit(MarkTier.SECONDARY, a.x, a.y - 18));
    }

    _talkArcGateFrame = governor._frame;
}

function preAdmittedGate(governor, key) {
    if (!governor || _talkArcGateFrame !== governor._frame) return null;
    return _talkArcGates.get(key) || null;
}

export function drawTalkArcs(ctx, {
    relationship,
    agentSprites,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    grade = null,
} = {}) {
    if (!ctx || !agentSprites) return;
    // 5.3 — the gather roll call shares this above-the-bodies pass; it is not a
    // chat arc and must draw even when nobody is talking.
    drawGatherRollCall(ctx, { agentSprites, zoom, now, motionScale, grade });

    const snapshot = relationshipSnapshot(relationship);
    if (!snapshot?.chatPairs) return;

    const boost = lightBoost(lighting);
    // 3.9 — shimmer snapped onto the shared 'working' band; reduced motion
    // keeps the legacy static value.
    const shimmer = motionScale === 0 ? 1 : 0.55 + 0.2 * pulseBand01('working', now, motionScale);
    const alpha = Math.min(0.95, shimmer * boost);
    const governor = getActiveMarkGovernor();

    for (const pair of prioritizedChatPairs(snapshot.chatPairs, agentSprites)) {
        const a = agentSprites.get(pair.aId);
        const b = agentSprites.get(pair.bId);
        if (!a || !b || a.isArrivalPending?.() || b.isArrivalPending?.()) continue;

        const start = { x: a.x, y: a.y - 18 };
        const end = { x: b.x, y: b.y - 18 };
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const dist = Math.hypot(dx, dy);
        const gate = preAdmittedGate(governor, `talk:${pair.aId}:${pair.bId}`)
            || (governor
                ? governor.admit(MarkTier.SECONDARY, start.x, start.y)
                : { draw: true, alpha: 1 });
        if (!gate.draw) continue;
        const control = {
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2 - Math.min(60, dist * 0.35),
        };

        const arcColor = gradeColor(THEME.chatting || '#f2d36b', grade);

        ctx.save();
        ctx.strokeStyle = rgba(arcColor, alpha * gate.alpha);
        ctx.lineWidth = 1.4 / (zoom || 1);
        if (motionScale === 0) ctx.setLineDash([2 / (zoom || 1), 4 / (zoom || 1)]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
        ctx.stroke();

        // #27 — a travelling mote runs along the arc so the live conversation is
        // visible: the dot shows which way the talk is flowing. Skipped entirely
        // under reduced motion (the dashed static arc already reads as "talking").
        if (motionScale !== 0) {
            const t = (now % TALK_MOTE_PERIOD_MS) / TALK_MOTE_PERIOD_MS;
            const mt = 1 - t;
            const mx = mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x;
            const my = mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y;
            ctx.setLineDash([]);
            ctx.fillStyle = rgba(arcColor, Math.min(1, (0.55 + alpha) * gate.alpha));
            ctx.beginPath();
            ctx.arc(mx, my, 1.8 / (zoom || 1), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }
}

export function relationshipLightSources({ relationship, agentSprites, lighting = null } = {}) {
    const snapshot = relationshipSnapshot(relationship);
    if (!snapshot || !agentSprites) return [];
    const sources = [];
    const boost = lightBoost(lighting);

    for (const [teamName, memberIds] of snapshot.teamToMembers?.entries?.() || []) {
        const sprites = sortedSpritesForTeam(memberIds, agentSprites);
        if (sprites.length < 2) continue;
        const color = getTeamColor(teamName);
        const center = sprites.reduce(
            (acc, sprite) => ({ x: acc.x + sprite.x / sprites.length, y: acc.y + sprite.y / sprites.length }),
            { x: 0, y: 0 },
        );
        sources.push({
            id: `council:${teamName}`,
            kind: 'orbit',
            x: center.x,
            y: center.y,
            color: color.accent,
            radius: 74,
            alpha: 0.24,
            intensity: 0.25 * boost,
        });
    }

    for (const pair of prioritizedChatPairs(snapshot.chatPairs, agentSprites)) {
        const a = agentSprites.get(pair.aId);
        const b = agentSprites.get(pair.bId);
        if (!a || !b) continue;
        sources.push({
            id: `talk:${pair.aId}:${pair.bId}`,
            kind: 'arc',
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2 - 18,
            endpoints: [{ x: a.x, y: a.y - 18 }, { x: b.x, y: b.y - 18 }],
            color: THEME.chatting || '#f2d36b',
            radius: 56,
            alpha: 0.22,
            intensity: 0.22 * boost,
        });
    }

    return sources;
}
