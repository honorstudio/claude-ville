import { drawEventShape } from '../shared/EventShapes.js';
import { buildingForTool } from '../../domain/services/ToolIdentity.js';
import { formatElapsed } from '../shared/Formatters.js';
import { pulseValueMs } from './PulsePolicy.js';

// 5.4 — work as a spatial score.
//
// On explicit request the selected run's last twenty minutes become a badged
// historical diagram over the village: the same waterfall rows the Activity
// Panel prints, placed at the semantic building their tool classifier names,
// with the time between them drawn as what it actually was — a long empty
// bracket for an approval interval, a dashed gap for time nothing was
// recorded. A scrubbable cursor lights one node at a time.
//
// Three honesty rules govern every line of this module:
//
//   1. Timestamp order is not causality. Nodes are never joined by a path:
//      each interval attaches to the node it precedes, so the diagram says
//      "this wait happened before that read", never "the agent walked here".
//   2. A semantic building is not an execution location. A physical position
//      is used only where a real replay sample exists (the retained minute of
//      `VillageDirector.replaySamples`); everything else sits at its building
//      anchor and is counted separately in the badge.
//   3. Unknown time stays unknown. A stall row is a gap, never a longer bar
//      and never a completion.
//
// Scrubbing is presentation only: this module reads a frozen row copy and
// never touches world, domain, or simulator state.

export const SCORE_NODE_LIMIT = 24;
// An approval interval reads as a bracket rather than a tick from here up.
export const SCORE_LONG_INTERVAL_MS = 20_000;
export const WORK_SCORE_REQUEST_EVENT = 'work-score:request';
export const WORK_SCORE_STATE_EVENT = 'work-score:state';
// One playback pass over the whole kept span, in the slow band's spirit: the
// cursor takes this long to walk the score once.
export const SCORE_PLAYBACK_MS = 24_000;

const GLYPH_CELL = 16;
// Slot geometry in world pixels. The drawn motif is up to 24 world px wide at
// the largest glyph step, so neighbouring slots keep a clear gap instead of
// stacking two silhouettes into an unreadable blob.
const SLOT_COLUMNS = 3;
const SLOT_DX = 44;
const SLOT_DY = 34;
const CHILD_DX = 22;
const BRACKET_MIN_PX = 22;
const BRACKET_MAX_PX = 180;
const BRACKET_MS_PER_PX = 900;
const LIT_TOLERANCE_MS = 1_500;
const REPLAY_MATCH_MS = 2_500;

const PLATE_FILL = 'rgba(16, 11, 8, 0.86)';
const PLATE_EDGE = 'rgba(199, 157, 76, 0.34)';
const BADGE_FILL = 'rgba(122, 44, 34, 0.94)';
const BADGE_TEXT = '#f8e7bd';
const SCORE_GOLD = '#f2d36b';
const SCORE_MUTED = '#b6a781';
const SCORE_TEXT = '#f6da82';
const FONT_BADGE = 'bold 10px "Press Start 2P", monospace';
const FONT_LINE = '9px "Press Start 2P", monospace';

// C5 shape grammar. One family per event kind; tool nodes resolve their family
// from the canonical tool classifier's district, never from colour alone.
const KIND_GLYPH = Object.freeze({
    turn: 'turn-sand',
    permission: 'incident-bracket',
    retry: 'incident-bracket',
    child: 'child-return',
    stall: null,
});

const BUILDING_GLYPH = Object.freeze({
    archive: 'read-page',
    forge: 'edit-strike',
    command: 'district-command',
    taskboard: 'task-slip',
    observatory: 'search-lens',
    portal: 'district-portal',
    harbor: 'district-harbor',
    mine: 'district-mine',
    watchtower: 'district-watchtower',
});

function toolGlyph(label, detail, building) {
    const tool = String(label || '').toLowerCase();
    if (/shell|bash|exec|run|terminal|zsh|sh$/.test(tool)) return 'shell-slate';
    if (/message|send|chat|reply/.test(tool)) return 'message-scroll';
    if (/grep|search|glob|find|web/.test(tool)) return 'search-lens';
    if (/edit|write|patch|apply/.test(tool)) return 'edit-strike';
    if (/read|view|cat|open/.test(tool)) return 'read-page';
    if (/task|todo|plan/.test(tool)) return 'task-slip';
    return BUILDING_GLYPH[building] || 'tool-unknown';
}

/**
 * Reduce waterfall rows to a bounded spatial score. Pure: rows in, model out.
 *
 * The most recent `SCORE_NODE_LIMIT` rows are kept so the cursor walks one
 * contiguous tail; older rows are reported as an exact overflow count plus the
 * list the panel prints. Every node keeps the row's own `provenance`, so the
 * score's exact/inferred vocabulary is the panel's by construction.
 */
export function buildSpatialWorkScore(rows, { agentId = null, agentName = '', now = Date.now() } = {}) {
    const source = Array.isArray(rows) ? rows.filter(row => Number.isFinite(Number(row?.at))) : [];
    if (!source.length) return null;
    const ordered = [...source].sort((a, b) => a.at - b.at);
    const kept = ordered.slice(-SCORE_NODE_LIMIT);
    const dropped = ordered.slice(0, ordered.length - kept.length);

    const nodes = [];
    for (const row of kept) {
        const at = Number(row.at);
        const endAt = Math.max(at, Number(row.endAt) || at);
        const base = {
            id: String(row.id || `${row.kind}:${at}`),
            kind: String(row.kind || 'tool'),
            at,
            endAt,
            durationMs: Math.max(0, Number(row.durationMs) || 0),
            provenance: row.provenance === 'exact' ? 'exact' : 'inferred',
            label: String(row.label || row.kind || 'Event'),
            detail: String(row.detail || row.label || ''),
            ongoing: row.ongoing === true,
        };
        if (Number.isFinite(Number(row.toolExitCode))) base.toolExitCode = Number(row.toolExitCode);
        if (row.childId) base.childId = String(row.childId);

        if (base.kind === 'tool') {
            const building = buildingForTool(base.label, base.detail);
            nodes.push({
                ...base,
                place: building ? 'building' : 'interval',
                building: building || null,
                glyph: toolGlyph(base.label, base.detail, building),
            });
            continue;
        }
        if (base.kind === 'child') {
            nodes.push({
                ...base,
                place: 'child',
                building: null,
                beside: true,
                glyph: 'child-return',
            });
            continue;
        }
        nodes.push({
            ...base,
            place: 'interval',
            building: null,
            glyph: KIND_GLYPH[base.kind] ?? null,
            bracket: base.kind === 'permission' || base.durationMs >= SCORE_LONG_INTERVAL_MS,
            gap: base.kind === 'stall',
        });
    }

    // Placement: a tool node owns its building; a child sits beside its real
    // parent's current place; an interval attaches to the node it precedes
    // (falling back to the one it follows) so no interval invents a location.
    const placedIndexes = nodes.map((node, index) => (node.place === 'building' ? index : -1)).filter(index => index >= 0);
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (node.place === 'building') continue;
        const after = placedIndexes.find(candidate => candidate > index);
        const before = [...placedIndexes].reverse().find(candidate => candidate < index);
        const anchor = node.place === 'child'
            ? (before ?? after ?? null)
            : (after ?? before ?? null);
        node.anchorIndex = anchor === undefined ? null : anchor;
        node.anchorBuilding = anchor === null || anchor === undefined ? null : nodes[anchor].building;
    }

    // Deterministic fan-out: nodes sharing one building take successive slots
    // so a busy Forge reads as a small cluster instead of one stacked glyph.
    const slots = new Map();
    for (const node of nodes) {
        const key = node.place === 'building' ? node.building : `anchor:${node.anchorBuilding || 'none'}`;
        const used = slots.get(key) || 0;
        node.slot = used;
        slots.set(key, used + 1);
    }

    const startAt = nodes[0].at;
    const endAt = nodes.reduce((max, node) => Math.max(max, node.endAt), startAt);
    const placedCount = nodes.filter(node => node.place === 'building').length;
    const childCount = nodes.filter(node => node.place === 'child').length;
    return {
        agentId: agentId ? String(agentId) : null,
        agentName: String(agentName || ''),
        builtAt: Number(now) || Date.now(),
        startAt,
        endAt: Math.max(endAt, startAt + 1),
        nodes,
        overflow: dropped.length,
        overflowRows: dropped.map(row => ({
            id: String(row.id || ''),
            label: String(row.label || ''),
            detail: String(row.detail || ''),
            at: Number(row.at),
            durationMs: Math.max(0, Number(row.durationMs) || 0),
            provenance: row.provenance === 'exact' ? 'exact' : 'inferred',
        })),
        counts: {
            nodes: nodes.length,
            placed: placedCount,
            children: childCount,
            intervals: nodes.length - placedCount - childCount,
            total: ordered.length,
        },
    };
}

/**
 * Resolve world geometry for a built score. `buildingAnchor(type)` returns the
 * building's world centre; `replayPosition(node)` returns a recorded position
 * or null. A node with neither is reported with `positionSource: 'none'` and
 * is counted, never silently dropped.
 *
 * Only a body-bearing node — a tool the agent ran, or a child beside it — may
 * take a recorded position. An interval is a duration mark attached to the
 * node it precedes, so giving it its own physical point would invent a place
 * for time nobody observed. Several nodes on one recorded point stack straight
 * up from it: a column says "same place, several events" where a sideways fan
 * would claim positions the sample never recorded.
 */
export function resolveWorkScoreGeometry(score, { buildingAnchor = null, replayPosition = null } = {}) {
    if (!score?.nodes?.length) return null;
    const placements = [];
    const recordedStacks = new Map();
    let recorded = 0;
    let semantic = 0;
    let unplaced = 0;
    for (let index = 0; index < score.nodes.length; index++) {
        const node = score.nodes[index];
        const anchorType = node.place === 'building' ? node.building : node.anchorBuilding;
        const bodyBearing = node.place === 'building' || node.place === 'child';
        const sample = bodyBearing && replayPosition ? replayPosition(node) : null;
        const anchor = anchorType && buildingAnchor ? buildingAnchor(anchorType) : null;
        let x = null;
        let y = null;
        let positionSource = 'none';
        if (sample && Number.isFinite(sample.x) && Number.isFinite(sample.y)) {
            const key = `${Math.round(sample.x)}:${Math.round(sample.y)}`;
            const height = recordedStacks.get(key) || 0;
            recordedStacks.set(key, height + 1);
            x = sample.x;
            y = sample.y - height * SLOT_DY;
            positionSource = 'replay';
            recorded += 1;
        } else if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
            const column = node.slot % SLOT_COLUMNS;
            const row = Math.floor(node.slot / SLOT_COLUMNS);
            // Slots fan sideways then forward, away from the building sprite.
            x = anchor.x + (column - 1) * SLOT_DX + (node.place === 'child' ? CHILD_DX : 0);
            y = anchor.y + row * SLOT_DY + (node.place === 'building' ? 0 : 8);
            positionSource = 'building';
            semantic += 1;
        } else {
            unplaced += 1;
        }
        placements.push({ index, id: node.id, x, y, positionSource });
    }
    return {
        placements,
        counts: { recorded, semantic, unplaced },
        signature: placements.map(p => `${p.id}:${Math.round(p.x ?? -9999)}:${Math.round(p.y ?? -9999)}:${p.positionSource}`).join('|'),
    };
}

/**
 * The world box the drawn score occupies, for the one explicit framing move
 * the operator asked for when opening the score. Null when nothing is placed.
 */
export function workScoreWorldBox(geometry, pad = 90) {
    const points = (geometry?.placements || []).filter(entry => entry.x !== null && entry.y !== null);
    if (!points.length) return null;
    const xs = points.map(entry => entry.x);
    const ys = points.map(entry => entry.y);
    return {
        minX: Math.min(...xs) - pad,
        maxX: Math.max(...xs) + pad,
        minY: Math.min(...ys) - pad,
        maxY: Math.max(...ys) + pad,
    };
}

export function scoreNodeState(node, cursorAt) {
    const cursor = Number(cursorAt);
    if (!Number.isFinite(cursor)) return 'future';
    if (node.durationMs > 0) {
        if (cursor >= node.at && cursor <= node.endAt) return 'lit';
    } else if (Math.abs(cursor - node.at) <= LIT_TOLERANCE_MS) {
        return 'lit';
    }
    return cursor > node.endAt ? 'past' : 'future';
}

export function litScoreNode(score, cursorAt) {
    if (!score?.nodes?.length) return null;
    let best = null;
    for (const node of score.nodes) {
        if (scoreNodeState(node, cursorAt) !== 'lit') continue;
        if (!best || node.at >= best.at) best = node;
    }
    if (best) return best;
    // Between nodes the cursor still belongs to the most recent passed node,
    // so the caption never goes blank mid-scrub.
    for (const node of score.nodes) {
        if (node.endAt <= cursorAt && (!best || node.endAt >= best.endAt)) best = node;
    }
    return best || score.nodes[0];
}

/**
 * Find a recorded position for a node from the retained replay samples.
 * Bounded, exact-match-in-time-window only: a node outside the retained
 * minute has no recorded position and must fall back to its building anchor.
 */
export function replaySampleLookup(samples, agentId, at, toleranceMs = REPLAY_MATCH_MS) {
    if (!Array.isArray(samples) || !samples.length || !agentId) return null;
    const target = Number(at);
    if (!Number.isFinite(target)) return null;
    let best = null;
    let bestDelta = Infinity;
    for (const sample of samples) {
        const delta = Math.abs(Number(sample?.ts) - target);
        if (!Number.isFinite(delta) || delta > toleranceMs || delta >= bestDelta) continue;
        const point = (sample.points || []).find(entry => String(entry?.id) === String(agentId));
        if (!point) continue;
        best = { x: Number(point.x), y: Number(point.y), ts: Number(sample.ts) };
        bestDelta = delta;
    }
    return best;
}

// Three legibility steps, not a fade: a passed node stays readable because
// "where did the time go" is answered by the whole diagram, not the cursor.
function alphaForState(state) {
    if (state === 'lit') return 1;
    return state === 'past' ? 0.78 : 0.46;
}

function intervalLengthPx(durationMs) {
    const px = Math.round(Number(durationMs) / BRACKET_MS_PER_PX);
    return Math.max(BRACKET_MIN_PX, Math.min(BRACKET_MAX_PX, px));
}

/**
 * Ground pass. Glyphs, brackets and gaps go on the retained ground-cue
 * texture, so buildings and bodies occlude the score exactly like every other
 * ground cue and Canvas/GPU parity is automatic.
 */
export function drawWorkScoreGround(ctx, {
    score = null,
    geometry = null,
    cursorAt = 0,
    zoom = 1,
    perfNow = 0,
    motionScale = 1,
} = {}) {
    if (!score?.nodes?.length || !geometry?.placements?.length) return 0;
    // The 16-cell motif keeps a roughly constant screen size (its inked core
    // is the middle 8 cells), so the diagram is legible at whatever zoom the
    // operator asked for it from.
    const step = Math.max(2, Math.min(3, Math.round(5 / Math.max(0.35, Number(zoom) || 1))));
    const litPulse = pulseValueMs('selection', perfNow, motionScale);
    let drawn = 0;
    ctx.save();
    for (const placement of geometry.placements) {
        if (placement.x === null || placement.y === null) continue;
        const node = score.nodes[placement.index];
        const state = scoreNodeState(node, cursorAt);
        const alpha = alphaForState(state);
        const x = placement.x;
        const y = placement.y;

        if (node.place === 'interval') {
            const length = intervalLengthPx(node.durationMs);
            const left = x - length / 2;
            const baseY = y + 10 * step;
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = node.gap ? SCORE_MUTED : SCORE_GOLD;
            ctx.lineWidth = (1.5 * step) / zoom;
            ctx.setLineDash(node.gap ? [(3 * step) / zoom, (4 * step) / zoom] : []);
            ctx.beginPath();
            ctx.moveTo(left, baseY);
            ctx.lineTo(left + length, baseY);
            if (node.bracket === true) {
                // A long empty bracket: end ticks, nothing inside. Nothing was
                // observed between them, so nothing is drawn there.
                ctx.moveTo(left, baseY - 5 * step);
                ctx.lineTo(left, baseY + 5 * step);
                ctx.moveTo(left + length, baseY - 5 * step);
                ctx.lineTo(left + length, baseY + 5 * step);
            }
            ctx.stroke();
            ctx.setLineDash([]);
            if (node.glyph) {
                ctx.globalAlpha = alpha * 0.9;
                drawEventShape(ctx, node.glyph, x - (GLYPH_CELL / 2) * step, baseY - 20 * step, step, node.gap ? SCORE_MUTED : SCORE_GOLD);
            }
            drawn += 1;
            continue;
        }

        // A placed node is a small plate carrying its authored silhouette: the
        // village is deliberately a diagram while the score is open, and a
        // gold glyph alone does not survive grass, road and plaza alike.
        const plate = 11 * step;
        // The plate keeps a floor: a not-yet-reached node is still part of the
        // diagram, only its glyph and edge step back.
        ctx.globalAlpha = Math.max(0.66, alpha) * 0.92;
        ctx.fillStyle = PLATE_FILL;
        ctx.fillRect(x - plate, y - plate - 2 * step, plate * 2, plate * 2);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = state === 'lit' ? SCORE_TEXT : PLATE_EDGE;
        ctx.lineWidth = (state === 'lit' ? 2 : 1) / zoom;
        ctx.strokeRect(x - plate, y - plate - 2 * step, plate * 2, plate * 2);
        drawEventShape(
            ctx,
            node.glyph || 'tool-unknown',
            x - (GLYPH_CELL / 2) * step,
            y - (GLYPH_CELL / 2) * step - 2 * step,
            step,
            state === 'lit' ? SCORE_TEXT : (node.place === 'child' ? SCORE_MUTED : SCORE_GOLD),
        );
        if (state === 'lit') {
            // The cursor's spatial expression: the plate's own edge brightens
            // on the slow band and one caret sits above it.
            ctx.globalAlpha = Math.max(0.55, litPulse);
            ctx.strokeStyle = SCORE_TEXT;
            ctx.lineWidth = 1 / zoom;
            ctx.strokeRect(x - plate - 2, y - plate - 2 * step - 2, plate * 2 + 4, plate * 2 + 4);
            ctx.beginPath();
            ctx.moveTo(x - 4 * step, y - plate - 6 * step);
            ctx.lineTo(x + 4 * step, y - plate - 6 * step);
            ctx.lineTo(x, y - plate - 2 * step);
            ctx.closePath();
            ctx.fillStyle = SCORE_TEXT;
            ctx.fill();
        }
        if (placement.positionSource === 'replay') {
            // Recorded position: a ground tick marks the nodes the retained
            // minute can actually place.
            ctx.globalAlpha = alpha * 0.8;
            ctx.strokeStyle = SCORE_TEXT;
            ctx.lineWidth = step / zoom;
            ctx.beginPath();
            ctx.moveTo(x - 6 * step, y + plate - step);
            ctx.lineTo(x + 6 * step, y + plate - step);
            ctx.stroke();
        }
        drawn += 1;
    }
    ctx.restore();
    return drawn;
}

function clockText(at) {
    const value = Number(at);
    if (!Number.isFinite(value) || value <= 0) return '--:--:--';
    const date = new Date(value);
    const pad = part => String(part).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function workScoreCaption(score, cursorAt) {
    const node = litScoreNode(score, cursorAt);
    if (!node) return '';
    const state = scoreNodeState(node, cursorAt);
    // Placement wording carries the placement rule: a tool sits AT its
    // building, a child BESIDE its real parent's place, an interval BEFORE
    // the node it precedes. Nothing claims to be an execution location.
    const anchor = node.anchorBuilding ? String(node.anchorBuilding).toUpperCase() : '';
    const place = node.place === 'building'
        ? `AT ${String(node.building || '').toUpperCase()}`
        : node.place === 'child'
            ? (anchor ? `BESIDE ${anchor}` : 'NO PLACE')
            : (anchor ? `BEFORE ${anchor}` : 'NO PLACE');
    const head = node.kind === 'stall'
        ? 'GAP · no recorded activity'
        : `${node.label.toUpperCase()} · ${formatElapsed(node.durationMs)} · ${node.provenance.toUpperCase()}`;
    return `${clockText(cursorAt)} · ${head} · ${place}${state === 'lit' ? '' : ' (passed)'}`;
}

export function workScoreBadgeLines(score, { cursorAt = 0, geometry = null, playing = false, cameraOwner = '' } = {}) {
    if (!score) return [];
    const counts = score.counts || {};
    const position = geometry?.counts || { recorded: 0, semantic: 0, unplaced: 0 };
    const lines = [
        `${score.agentName || 'Selected run'} · last ${formatElapsed(score.endAt - score.startAt)}`,
        workScoreCaption(score, cursorAt),
        `${counts.nodes || 0} of ${counts.total || 0} nodes · ${counts.placed || 0} placed · ${counts.intervals || 0} intervals${score.overflow ? ` · ${score.overflow} earlier in panel` : ''}`,
        `positions ${position.recorded} recorded · ${position.semantic} semantic${position.unplaced ? ` · ${position.unplaced} unplaced` : ''}`,
        `${playing ? 'PLAYING' : 'SCRUB'} · camera ${cameraOwner || 'unclaimed'} · LIVE in panel`,
    ];
    return lines.filter(Boolean);
}

/**
 * Screen pass. The `REPLAY` badge and every exact count live once on the
 * shared upper overlay, in both backends, so the counts survive the night
 * grade, dense load and the GPU path exactly as the ground cues do not.
 */
export function drawWorkScoreScreen(ctx, viewport, {
    score = null,
    geometry = null,
    cursorAt = 0,
    playing = false,
    cameraOwner = '',
} = {}) {
    if (!score || !viewport?.width) return false;
    const lines = workScoreBadgeLines(score, { cursorAt, geometry, playing, cameraOwner });
    ctx.save();
    ctx.textBaseline = 'top';
    ctx.font = FONT_LINE;
    const widths = lines.map(line => ctx.measureText(line).width);
    ctx.font = FONT_BADGE;
    const badgeLabel = 'REPLAY · WORK SCORE';
    const badgeWidth = ctx.measureText(badgeLabel).width;
    const contentWidth = Math.max(badgeWidth, ...widths);
    const plateWidth = Math.ceil(contentWidth) + 24;
    const plateHeight = 28 + lines.length * 13 + 10;
    const left = Math.round((viewport.width - plateWidth) / 2);
    const top = 16;

    ctx.fillStyle = PLATE_FILL;
    ctx.fillRect(left, top, plateWidth, plateHeight);
    ctx.strokeStyle = PLATE_EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, plateWidth - 1, plateHeight - 1);

    // The badge is unmistakable: this frame is history, not the live village.
    ctx.fillStyle = BADGE_FILL;
    ctx.fillRect(left + 8, top + 8, Math.ceil(badgeWidth) + 12, 18);
    ctx.fillStyle = BADGE_TEXT;
    ctx.font = FONT_BADGE;
    ctx.fillText(badgeLabel, left + 14, top + 12);

    ctx.font = FONT_LINE;
    lines.forEach((line, index) => {
        ctx.fillStyle = index === 1 ? SCORE_TEXT : SCORE_MUTED;
        ctx.fillText(line, left + 12, top + 32 + index * 13);
    });
    ctx.restore();
    return true;
}
