// Activity glyph badge (visual-upgrade item #9) — the compact replacement for
// the always-dark name pill at low zoom.
//
// Instead of an overlapping rectangle of text per agent (the busy-day
// "pill-soup"), each agent flies a tiny ~9x9 illuminated trade-emblem of the
// tool category it is working: a lens for search, a feather for edit, a gear
// for shell, a globe for web, a pick for mine, a scroll for tasks. The emblem
// is tinted by the agent's STATUS color so the world reads as a constellation
// of glowing status icons that never mush into a wall of text.
//
// Pure draw helper: it does NO motion of its own (the optional pulse only
// rides the caller's frame/motionScale and degrades to a steady glow under
// prefers-reduced-motion). The caller has already translated/scaled into a
// fixed screen-space frame centered on the badge anchor.

import { toolCategory } from '../../domain/services/ToolIdentity.js';
import { pulseValue } from './PulsePolicy.js';

// Map a tool-category (from ToolIdentity.toolCategory) to a glyph key. The
// search category covers both local search and web tools; we split web out by
// building when the classification is available, otherwise lens is the default.
const CATEGORY_GLYPH = Object.freeze({
    read: 'book',
    search: 'lens',
    write: 'feather',
    exec: 'gear',
    task: 'scroll',
    other: 'dot',
});

// Building hints that override the category glyph for richer reads. The
// classifier resolves Bash/web/etc. to a building even when category is broad.
const BUILDING_GLYPH = Object.freeze({
    observatory: 'globe',
    mine: 'pick',
    portal: 'globe',
    harbor: 'anchor',
});

/**
 * Resolve the glyph key for an agent's current tool.
 * @param {string} tool - raw tool name (agent.currentTool)
 * @param {string|null} building - optional classified building (overrides category)
 * @returns {string} glyph key understood by drawToolGlyphBadge
 */
export function toolGlyphKey(tool, building = null) {
    if (building && BUILDING_GLYPH[building]) return BUILDING_GLYPH[building];
    return CATEGORY_GLYPH[toolCategory(tool)] || 'dot';
}

// Each glyph is a tiny vector path drawn within a unit box of half-size `r`
// centered at the origin, in the caller's frame. Strokes use the badge color;
// fills use a brightened version so the emblem reads "lit".
function strokeGlyph(ctx, key, r) {
    ctx.beginPath();
    switch (key) {
        case 'lens': { // search — magnifier
            const rr = r * 0.62;
            ctx.arc(-r * 0.2, -r * 0.2, rr, 0, Math.PI * 2);
            ctx.moveTo(rr * 0.55 - r * 0.2, rr * 0.55 - r * 0.2);
            ctx.lineTo(r, r);
            break;
        }
        case 'feather': { // edit/write — quill stroke
            ctx.moveTo(-r, r);
            ctx.lineTo(r, -r);
            ctx.moveTo(r, -r);
            ctx.lineTo(r * 0.2, -r);
            ctx.moveTo(r, -r);
            ctx.lineTo(r, -r * 0.2);
            break;
        }
        case 'gear': { // shell/exec — gear teeth
            const rr = r * 0.7;
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * Math.PI * 2;
                ctx.moveTo(Math.cos(a) * rr * 0.6, Math.sin(a) * rr * 0.6);
                ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
            }
            ctx.moveTo(rr * 0.6, 0);
            ctx.arc(0, 0, rr * 0.6, 0, Math.PI * 2);
            break;
        }
        case 'globe': { // web — globe with meridian
            ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
            ctx.moveTo(-r * 0.85, 0);
            ctx.lineTo(r * 0.85, 0);
            ctx.moveTo(0, -r * 0.85);
            ctx.ellipse(0, 0, r * 0.42, r * 0.85, 0, -Math.PI / 2, Math.PI / 2);
            break;
        }
        case 'pick': { // mine — pickaxe
            ctx.moveTo(-r, r);
            ctx.lineTo(r, -r);
            ctx.moveTo(r * 0.4, -r);
            ctx.quadraticCurveTo(r, -r, r, -r * 0.4);
            break;
        }
        case 'scroll': { // task — unfurled scroll
            ctx.moveTo(-r * 0.7, -r * 0.7);
            ctx.lineTo(r * 0.7, -r * 0.7);
            ctx.moveTo(-r * 0.7, 0);
            ctx.lineTo(r * 0.7, 0);
            ctx.moveTo(-r * 0.7, r * 0.7);
            ctx.lineTo(r * 0.7, r * 0.7);
            break;
        }
        case 'book': { // read — open book
            ctx.moveTo(0, -r * 0.7);
            ctx.lineTo(0, r * 0.7);
            ctx.moveTo(0, -r * 0.6);
            ctx.quadraticCurveTo(-r, -r * 0.8, -r, r * 0.6);
            ctx.moveTo(0, -r * 0.6);
            ctx.quadraticCurveTo(r, -r * 0.8, r, r * 0.6);
            break;
        }
        case 'anchor': { // harbor — anchor
            ctx.moveTo(0, -r);
            ctx.lineTo(0, r * 0.7);
            ctx.moveTo(-r * 0.6, r * 0.7);
            ctx.lineTo(0, r);
            ctx.lineTo(r * 0.6, r * 0.7);
            ctx.moveTo(-r * 0.5, 0);
            ctx.lineTo(r * 0.5, 0);
            break;
        }
        default: // dot — idle / unknown
            ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
            break;
    }
    ctx.stroke();
}

/**
 * Draw an illuminated tool-category emblem at the origin of the caller's frame.
 * The caller is responsible for translate/scale into fixed screen space.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {string} opts.glyph   - glyph key (see toolGlyphKey)
 * @param {string} opts.color   - status color (hex/rgba)
 * @param {string} [opts.panel] - rounded backplate fill
 * @param {string} [opts.border]- backplate border
 * @param {number} [opts.size]  - emblem box size in px (default 9)
 * @param {number} [opts.frame] - animation frame for the optional lit pulse
 * @param {number} [opts.motionScale] - 0 freezes the pulse (reduced-motion)
 */
export function drawToolGlyphBadge(ctx, opts = {}) {
    const {
        glyph = 'dot',
        color = '#f2d36b',
        panel = 'rgba(20, 14, 10, 0.82)',
        border = 'rgba(255, 242, 190, 0.55)',
        size = 9,
        frame = 0,
        motionScale = 1,
    } = opts;

    const pad = 3;
    const box = size + pad * 2;
    const half = box / 2;
    const r = size / 2;

    ctx.save();

    // Backplate keeps the emblem legible over dense terrain. Static — no motion.
    ctx.fillStyle = panel;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(-half, -half, box, box, 3);
    } else {
        ctx.rect(-half, -half, box, box);
    }
    ctx.fill();
    ctx.stroke();

    // Lit glow: a soft status-colored bloom under the glyph. Pulse rides the
    // slow "recent" band and freezes to a steady mid-glow under reduced motion.
    const glow = motionScale > 0 ? pulseValue('recent', frame, motionScale) : 0.62;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.28 + 0.32 * glow;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, r + 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // The emblem itself, in the status color with a hairline shadow for read.
    ctx.shadowColor = 'rgba(8, 5, 4, 0.7)';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeGlyph(ctx, glyph, r * 0.78);

    ctx.restore();
}
