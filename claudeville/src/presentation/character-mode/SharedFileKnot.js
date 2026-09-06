import { TILE_HALF_WIDTH, TILE_HALF_HEIGHT } from './Projection.js';
import { gradeColor } from './AtmosphereState.js';
import { drawEventShape } from '../shared/EventShapes.js';

// 4.5 — the shared-file knot.
//
// `agent.collisions` are server-detected exact canonical-path overlaps with
// per-edge observation times (services/workingSet.js). RelationshipState
// reduces them to one peer edge plus exact per-building counts; this module
// draws that snapshot and nothing else:
//
//   - the thread and its knot go on the retained ground cue texture, so
//     buildings and bodies occlude them like every other ground cue;
//   - the label goes once on the shared upper Canvas overlay in both backends;
//   - static band. No pulse, no dash travel: the reduced-motion frame is the
//     same frame, and the ground texture stays cacheable.
//
// Copy discipline: overlap is evidence, not a conflict. The label says
// `recent shared file` unless the collision established concurrency (both
// observations inside one minute), and a peer without a drawable body is named
// `unavailable`, never silently dropped.

const THREAD_WRITE = '#d8b46a';
const THREAD_READ = '#9a93a8';
const KNOT_WRITE = '#f2d36b';
const KNOT_READ = '#b8b0c2';
const PLATE_FILL = 'rgba(20, 14, 10, 0.85)';
const PLATE_TEXT = '#f6da82';
const PLATE_MUTED = '#cbbfa4';
const PLATE_FONT = 'bold 7px "Press Start 2P", monospace';
const PLATE_CHAR_WIDTH = 7;
const PLATE_LINE_HEIGHT = 12;
const PLATE_PADDING_X = 8;
const PLATE_PADDING_Y = 5;
// A thread is a short local diagram, never a map-wide cable: it stops after
// this much tile travel and the knot sits at its bend either way.
const MAX_THREAD_TILES = 7;
const KNOT_CELL = 16;

function rgba(hex, alpha) {
    const text = String(hex || '');
    if (!/^#[0-9a-f]{6}$/i.test(text)) return text;
    const value = Number.parseInt(text.slice(1), 16);
    return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}

function lightBoost(lighting) {
    return Math.max(0.5, Math.min(1.6, lighting?.lightBoost ?? 1));
}

function edgeSprites(overlap, agentSprites) {
    const edge = overlap?.edge;
    if (!edge || !agentSprites?.get) return null;
    const from = agentSprites.get(String(overlap.selectedId));
    const to = agentSprites.get(String(edge.peerId));
    if (!from || !to || from === to) return null;
    if (from.isArrivalPending?.() || to.isArrivalPending?.()) return null;
    return { from, to };
}

/**
 * The angular thread: two isometric-axis legs with the knot at their bend.
 * Long separations are clipped to MAX_THREAD_TILES of travel, so the diagram
 * stays local and the label keeps naming the peer. The longer leg is walked
 * first, which puts the knot out past the selected body's own tile cluster
 * instead of under it.
 */
function threadGeometry(from, to) {
    const ax = from.x;
    const ay = from.y - 4;
    const dx = to.x - ax;
    const dy = (to.y - 4) - ay;
    const tileX = (dx / TILE_HALF_WIDTH + dy / TILE_HALF_HEIGHT) / 2;
    const tileY = (dy / TILE_HALF_HEIGHT - dx / TILE_HALF_WIDTH) / 2;
    const travel = Math.abs(tileX) + Math.abs(tileY);
    if (travel < 0.35) return null;
    const scale = Math.min(1, MAX_THREAD_TILES / travel);
    const legX = tileX * scale;
    const legY = tileY * scale;
    const yFirst = Math.abs(legY) > Math.abs(legX);
    const bendTileX = yFirst ? 0 : legX;
    const bendTileY = yFirst ? legY : 0;
    return {
        start: { x: ax, y: ay },
        bend: {
            x: ax + (bendTileX - bendTileY) * TILE_HALF_WIDTH,
            y: ay + (bendTileX + bendTileY) * TILE_HALF_HEIGHT,
        },
        end: {
            x: ax + (legX - legY) * TILE_HALF_WIDTH,
            y: ay + (legX + legY) * TILE_HALF_HEIGHT,
        },
        clipped: scale < 1,
    };
}

/**
 * Ground pass. Draws at most one thread and one knot for the selected agent.
 * `allowThread` is false under annotation pressure: a hundred agents get the
 * label's exact counts and no lines at all.
 */
export function drawSharedFileKnot(ctx, {
    overlap = null,
    agentSprites = null,
    zoom = 1,
    lighting = null,
    grade = null,
    allowThread = true,
} = {}) {
    if (!ctx || !allowThread) return false;
    const pair = edgeSprites(overlap, agentSprites);
    if (!pair) return false;
    const geometry = threadGeometry(pair.from, pair.to);
    if (!geometry) return false;

    const write = overlap.edge.kind === 'write-write';
    const boost = lightBoost(lighting);
    const thread = gradeColor(write ? THREAD_WRITE : THREAD_READ, grade);
    const knot = gradeColor(write ? KNOT_WRITE : KNOT_READ, grade);
    const alpha = Math.min(0.7, (write ? 0.52 : 0.34) * boost);
    const unit = 1 / (zoom || 1);

    ctx.save();
    ctx.strokeStyle = rgba(thread, alpha);
    ctx.lineWidth = (write ? 1.4 : 1) * unit;
    // The advisory read/write thread is a broken line; two writers get a solid
    // one. Both dash patterns are fixed — no travelling offset.
    ctx.setLineDash(write ? [] : [3 * unit, 5 * unit]);
    ctx.beginPath();
    ctx.moveTo(geometry.start.x, geometry.start.y);
    ctx.lineTo(geometry.bend.x, geometry.bend.y);
    ctx.lineTo(geometry.end.x, geometry.end.y);
    ctx.stroke();
    ctx.restore();

    drawEventShape(
        ctx,
        write ? 'pencil-double' : 'pencil-single',
        geometry.bend.x - KNOT_CELL / 2,
        geometry.bend.y - KNOT_CELL / 2,
        1,
        rgba(knot, Math.min(0.95, alpha + 0.3)),
    );
    return true;
}

function overlapLines(overlap) {
    const edge = overlap?.edge;
    if (!edge) return [];
    const lines = [];
    const writers = Number.isFinite(edge.writers) ? edge.writers : null;
    const readers = Number.isFinite(edge.readers) ? edge.readers : null;
    if (writers === null) {
        // No per-edge observations (older server payload): report participants.
        lines.push({ text: `${edge.participants} agents · ${edge.basename}`, muted: false });
    } else if (edge.kind === 'write-write') {
        lines.push({ text: `${writers} writers · ${edge.basename}`, muted: false });
    } else {
        const readerText = readers === 1 ? '1 reader' : `${readers} readers`;
        lines.push({ text: `${writers} writer · ${readerText} · ${edge.basename}`, muted: false });
    }
    const state = !edge.available
        ? 'unavailable'
        : (edge.overlapKind === 'concurrent' ? 'both observed within 60s' : 'recent shared file');
    lines.push({ text: `${edge.peerName} · ${state}`, muted: true });
    for (const entry of overlap.aggregates || []) {
        lines.push({
            text: `${String(entry.building).toUpperCase()} · ${entry.files} shared ${entry.files === 1 ? 'file' : 'files'}`,
            muted: true,
        });
    }
    if (overlap.otherFiles > 0) {
        lines.push({
            text: `+${overlap.otherFiles} more shared ${overlap.otherFiles === 1 ? 'file' : 'files'}`,
            muted: true,
        });
    }
    return lines;
}

/**
 * Upper-overlay pass. One plate per selected agent, anchored over the knot when
 * a thread was drawn and over the agent itself otherwise, so the exact counts
 * survive dense load, night grade and the GPU backend alike.
 */
export function drawSharedFileOverlapLabel(ctx, {
    overlap = null,
    agentSprites = null,
    zoom = 1,
    threaded = true,
} = {}) {
    if (!ctx || !overlap?.edge) return false;
    const selected = agentSprites?.get?.(String(overlap.selectedId));
    if (!selected) return false;
    const lines = overlapLines(overlap);
    if (!lines.length) return false;

    const pair = threaded ? edgeSprites(overlap, agentSprites) : null;
    const geometry = pair ? threadGeometry(pair.from, pair.to) : null;
    const anchorX = geometry ? geometry.bend.x : selected.x;
    const anchorY = geometry ? geometry.bend.y - KNOT_CELL : selected.y - 46;

    const width = PLATE_PADDING_X * 2
        + Math.max(...lines.map(line => line.text.length)) * PLATE_CHAR_WIDTH;
    const height = PLATE_PADDING_Y * 2 + lines.length * PLATE_LINE_HEIGHT;
    const scale = 1 / (zoom || 1);

    ctx.save();
    ctx.translate(anchorX, anchorY);
    ctx.scale(scale, scale);
    ctx.font = PLATE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = PLATE_FILL;
    ctx.fillRect(-width / 2, -height, width, height);
    ctx.strokeStyle = rgba(overlap.edge.kind === 'write-write' ? KNOT_WRITE : KNOT_READ, 0.8);
    ctx.lineWidth = 1;
    ctx.strokeRect(-width / 2, -height, width, height);
    let y = -height + PLATE_PADDING_Y + PLATE_LINE_HEIGHT / 2;
    for (const line of lines) {
        ctx.fillStyle = line.muted ? PLATE_MUTED : PLATE_TEXT;
        ctx.fillText(line.text, 0, y);
        y += PLATE_LINE_HEIGHT;
    }
    ctx.restore();
    return true;
}
