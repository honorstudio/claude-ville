import { TILE_HALF_WIDTH, TILE_HALF_HEIGHT } from './Projection.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';

// Crowd cluster group visuals: when CrowdClusters reports a dense group
// (3+ agents in a cell), draw one subtle shared ground aura under the group
// and an "×N" count badge above it so swarms stay readable.
//
// Pulse band: static (no repeating motion), matching council rings. Alpha is
// modulated only by the slow-changing lighting boost, so there is no
// motionScale gate.
//
// 3.9 — the ground auras are AMBIENT tier in the mark governor (the first to
// dim in a busy region); under reduced motion the governor degrades to its
// static alpha cap with no region culling, per the governor contract. The
// count badges stay untiered: they are the density summary that must remain
// precisely when a region overflows.
//
// Hot path: called every frame. No per-cluster object/array/gradient
// allocations; colors are constant strings modulated via ctx.globalAlpha.

const AURA_FILL = 'rgba(246, 218, 130, 1)';
const AURA_STROKE = 'rgba(214, 169, 81, 1)';
const BADGE_PANEL = 'rgba(20, 14, 10, 0.85)';
const BADGE_BORDER = 'rgba(214, 169, 81, 0.8)';
const BADGE_TEXT = '#f6da82';
const BADGE_FONT = 'bold 7px "Press Start 2P", monospace';
const BADGE_HEIGHT = 13;
const BADGE_CHAR_WIDTH = 7;
const BADGE_PADDING_X = 8;

const STATUS_AURA_FALLBACK = Object.freeze({
    fill: AURA_FILL,
    stroke: AURA_STROKE,
    badge: BADGE_BORDER,
});

const STATUS_AURA = Object.freeze({
    [AgentStatus.WORKING]: STATUS_AURA_FALLBACK,
    [AgentStatus.IDLE]: STATUS_AURA_FALLBACK,
    [AgentStatus.COMPLETED]: STATUS_AURA_FALLBACK,
    [AgentStatus.WAITING]: Object.freeze({
        fill: 'rgba(111, 179, 217, 1)',
        stroke: 'rgba(91, 150, 190, 1)',
        badge: 'rgba(91, 150, 190, 0.8)',
    }),
    [AgentStatus.WAITING_ON_USER]: Object.freeze({
        fill: 'rgba(111, 179, 217, 1)',
        stroke: 'rgba(91, 150, 190, 1)',
        badge: 'rgba(91, 150, 190, 0.8)',
    }),
    [AgentStatus.RATE_LIMITED]: Object.freeze({
        fill: 'rgba(251, 146, 60, 1)',
        stroke: 'rgba(234, 88, 12, 1)',
        badge: 'rgba(234, 88, 12, 0.82)',
    }),
    [AgentStatus.ERRORED]: Object.freeze({
        fill: 'rgba(239, 68, 68, 1)',
        stroke: 'rgba(185, 28, 28, 1)',
        badge: 'rgba(185, 28, 28, 0.84)',
    }),
});

const PIP_RADIUS = 3;
const PIP_GAP = 4;
const PIP_ROW_HEIGHT = 8;
const STANDARD_PADDING_TOP = 3;
const MAX_PIPS = 3;

const _badgeTextCache = new Map();

function badgeText(count) {
    let text = _badgeTextCache.get(count);
    if (!text) {
        text = `×${count}`;
        _badgeTextCache.set(count, text);
    }
    return text;
}

// Pick up to MAX_PIPS status categories present in a cluster, ranked by share
// (count desc, then status key for a stable order). Returns aura entries so the
// standard's pips reuse the same heraldic palette as the ground aura.
function topStatusPips(statuses) {
    if (!statuses) return null;
    const keys = Object.keys(statuses);
    if (keys.length === 0) return null;
    keys.sort((a, b) => (statuses[b] - statuses[a]) || a.localeCompare(b));
    const pips = [];
    for (let i = 0; i < keys.length && pips.length < MAX_PIPS; i++) {
        pips.push(statusAura(keys[i]));
    }
    return pips;
}

function lightBoost(lighting) {
    return Math.max(0.45, Math.min(1.8, lighting?.lightBoost ?? 1));
}

function clusterWorldX(cluster) {
    return (cluster.tileX - cluster.tileY) * TILE_HALF_WIDTH;
}

function clusterWorldY(cluster) {
    return (cluster.tileX + cluster.tileY) * TILE_HALF_HEIGHT;
}

function auraRadiusX(cluster) {
    return Math.min(120, 56 + (cluster.count || 0) * 4);
}

function statusAura(status) {
    return STATUS_AURA[status] || STATUS_AURA_FALLBACK;
}

// Ground pass: one soft isometric ellipse per dense cluster, drawn with the
// other pre-sprite relationship layers so agents render on top of it.
export function drawCrowdClusterAuras(ctx, { crowdStats, zoom = 1, lighting = null } = {}) {
    const clusters = crowdStats?.clusters;
    if (!ctx || !clusters || clusters.length === 0) return;

    const boost = lightBoost(lighting);
    const governor = getActiveMarkGovernor();
    const fillAlpha = Math.min(0.12, 0.07 * boost);
    const strokeAlpha = Math.min(0.3, 0.18 * boost);

    ctx.save();
    ctx.lineWidth = 1.2 / (zoom || 1);
    for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        const x = clusterWorldX(cluster);
        const y = clusterWorldY(cluster) + 4;
        const gate = governor
            ? governor.admit(MarkTier.AMBIENT, x, y)
            : { draw: true, alpha: 1 };
        if (!gate.draw) continue;
        const rx = auraRadiusX(cluster);
        const ry = rx * 0.5;
        const aura = statusAura(cluster.dominantStatus);

        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.globalAlpha = fillAlpha * gate.alpha;
        ctx.fillStyle = aura.fill;
        ctx.fill();
        ctx.globalAlpha = strokeAlpha * gate.alpha;
        ctx.strokeStyle = aura.stroke;
        ctx.stroke();
    }
    ctx.restore();
}

// Overlay pass: a heraldic standard above each dense cluster, drawn after the
// depth-sorted sprite pass so it stays readable over the crowd. Shows the total
// "×N" count plus up to 3 status pips (working/waiting/errored, …) so hidden
// overflow agents are summarized by colour rather than silently dropped. Scaled
// by 1/zoom so the standard keeps a constant on-screen size. Static — no motion,
// so the prefers-reduced-motion rendering is identical.
export function drawCrowdClusterBadges(ctx, { crowdStats, zoom = 1, agentSprites } = {}) {
    // At dense load remembered residents share one exact building count.
    const staleGroups = new Map();
    for (const sprite of agentSprites?.values?.() || []) {
        sprite.staleGrouped = false;
        if (agentSprites.size < 24 || !sprite.agent?.resident || sprite.observation?.state !== 'stale'
            || sprite.selected || sprite.hovered || ['waiting_on_user', 'errored', 'rate_limited'].includes(sprite.agent.status)) continue;
        const building = sprite._lastBuildingType || sprite.agent.lastKnownBuildingType;
        if (!building) continue;
        let group = staleGroups.get(building);
        if (!group) { group = { count: 0, x: 0, y: 0 }; staleGroups.set(building, group); }
        group.count++;
        group.x += sprite.x;
        group.y += sprite.y;
        sprite.staleGrouped = true;
    }
    if (ctx && staleGroups.size) {
        ctx.save();
        ctx.font = BADGE_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const group of staleGroups.values()) {
            const text = `${group.count} stale`;
            const width = BADGE_PADDING_X + text.length * BADGE_CHAR_WIDTH;
            ctx.save();
            ctx.translate(group.x / group.count, group.y / group.count - 56);
            ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
            ctx.fillStyle = BADGE_PANEL;
            ctx.fillRect(-width / 2, -BADGE_HEIGHT / 2, width, BADGE_HEIGHT);
            ctx.fillStyle = BADGE_TEXT;
            ctx.fillText(text, 0, 0);
            ctx.restore();
        }
        ctx.restore();
    }
    const clusters = crowdStats?.clusters;
    if (!ctx || !clusters || clusters.length === 0) return;

    const s = 1 / (zoom || 1);
    ctx.save();
    ctx.font = BADGE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        const text = badgeText(cluster.count || 0);
        const pips = topStatusPips(cluster.statuses);
        const pipCount = pips ? pips.length : 0;
        const countWidth = BADGE_PADDING_X + text.length * BADGE_CHAR_WIDTH;
        const pipRowWidth = pipCount > 0
            ? pipCount * PIP_RADIUS * 2 + (pipCount - 1) * PIP_GAP
            : 0;
        const w = Math.max(countWidth, pipRowWidth + BADGE_PADDING_X);
        const h = pipCount > 0
            ? BADGE_HEIGHT + STANDARD_PADDING_TOP + PIP_ROW_HEIGHT
            : BADGE_HEIGHT;
        const x = clusterWorldX(cluster);
        const y = clusterWorldY(cluster) - auraRadiusX(cluster) * 0.5 - 12;
        const aura = statusAura(cluster.dominantStatus);

        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);
        ctx.fillStyle = BADGE_PANEL;
        ctx.strokeStyle = aura.badge;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-w / 2, -h / 2, w, h, 4);
        } else {
            ctx.rect(-w / 2, -h / 2, w, h);
        }
        ctx.fill();
        ctx.stroke();

        const countY = pipCount > 0 ? -h / 2 + BADGE_HEIGHT / 2 : 0.5;
        ctx.fillStyle = BADGE_TEXT;
        ctx.fillText(text, 0, countY);

        if (pipCount > 0) {
            const pipY = h / 2 - PIP_ROW_HEIGHT / 2;
            let pipX = -pipRowWidth / 2 + PIP_RADIUS;
            for (let p = 0; p < pipCount; p++) {
                const pip = pips[p];
                ctx.beginPath();
                ctx.arc(pipX, pipY, PIP_RADIUS, 0, Math.PI * 2);
                ctx.fillStyle = pip.fill;
                ctx.fill();
                ctx.strokeStyle = pip.stroke;
                ctx.stroke();
                pipX += PIP_RADIUS * 2 + PIP_GAP;
            }
        }
        ctx.restore();
    }
    ctx.restore();
}
