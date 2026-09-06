#!/usr/bin/env node
/**
 * Procedural Grok character sheets (no PixelLab).
 *
 * Emits ClaudeVille character sheets:
 *   8 directions (S SE E NE N NW W SW)
 *   × 10 rows (6 walk + 4 breathing-idle)
 *   × 92px cells → 736×920 RGBA PNG
 *
 * Usage:
 *   node scripts/sprites/generate-grok-procedural.mjs
 *   node scripts/sprites/generate-grok-procedural.mjs --id=agent.grok.base
 *   node scripts/sprites/generate-grok-procedural.mjs --preview
 *
 * Design: cosmic truthseeker — void coat, electric cyan trim, open hands,
 * star mote, no weapons / hood-assassin silhouette.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');
const spritesRoot = join(repoRoot, 'claudeville/assets/sprites/characters');

const CELL = 92;
const DIRS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const WALK = 6;
const IDLE = 4;
const COLS = DIRS.length;
const ROWS = WALK + IDLE;

const args = new Set(process.argv.slice(2));
const onlyId = process.argv.find((a) => a.startsWith('--id='))?.slice(5) || null;
const writePreview = args.has('--preview');

// ─── Palettes ────────────────────────────────────────────────

const PALETTES = {
  base: {
    outline: [8, 8, 14, 255],
    coat: [20, 20, 34, 255],
    coatMid: [28, 28, 48, 255],
    coatDark: [12, 12, 20, 255],
    pants: [16, 16, 26, 255],
    pantsDark: [10, 10, 16, 255],
    boot: [14, 14, 22, 255],
    bootHi: [30, 30, 44, 255],
    trim: [125, 249, 255, 255],
    trimDim: [34, 211, 238, 255],
    trimGlow: [232, 247, 255, 255],
    skin: [232, 198, 168, 255],
    skinShade: [196, 150, 120, 255],
    hair: [230, 235, 245, 255],
    hairShade: [180, 190, 210, 255],
    streak: [125, 249, 255, 255],
    cloak: [18, 18, 32, 255],
    cloakTrim: [34, 211, 238, 255],
    satchel: [58, 42, 32, 255],
    satchelTrim: [125, 249, 255, 255],
    eye: [20, 24, 32, 255],
    eyeGlow: [125, 249, 255, 255],
    mote: [232, 247, 255, 255],
    moteCore: [125, 249, 255, 255],
  },
  composer: {
    outline: [8, 8, 14, 255],
    coat: [28, 32, 44, 255],
    coatMid: [40, 48, 62, 255],
    coatDark: [18, 20, 28, 255],
    pants: [22, 26, 36, 255],
    pantsDark: [14, 16, 22, 255],
    boot: [18, 20, 28, 255],
    bootHi: [40, 48, 62, 255],
    trim: [165, 243, 252, 255],
    trimDim: [103, 232, 249, 255],
    trimGlow: [236, 254, 255, 255],
    skin: [232, 198, 168, 255],
    skinShade: [196, 150, 120, 255],
    hair: [210, 220, 235, 255],
    hairShade: [160, 170, 190, 255],
    streak: [165, 243, 252, 255],
    cloak: [30, 36, 50, 255],
    cloakTrim: [103, 232, 249, 255],
    satchel: [58, 42, 32, 255],
    satchelTrim: [165, 243, 252, 255],
    eye: [20, 24, 32, 255],
    eyeGlow: [165, 243, 252, 255],
    mote: [236, 254, 255, 255],
    moteCore: [165, 243, 252, 255],
    headband: [103, 232, 249, 255],
  },
};

const VARIANTS = {
  'agent.grok.base': {
    palette: 'base',
    cloak: true,
    headband: false,
    satchel: true,
    hairLong: true,
    coatLength: 1.0,
    lean: 0,
  },
  'agent.grok.composer': {
    palette: 'composer',
    cloak: false,
    headband: true,
    satchel: true,
    hairLong: false,
    coatLength: 0.75,
    lean: 0.15,
  },
};

// ─── Low-level drawing ───────────────────────────────────────

function createCell() {
  return new PNG({ width: CELL, height: CELL, colorType: 6 });
}

function clear(png) {
  png.data.fill(0);
}

function setPx(png, x, y, rgba) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (png.width * y + x) << 2;
  const [r, g, b, a] = rgba;
  // Simple over: later opaque pixels win when a is high
  if (a >= 250 || png.data[i + 3] === 0) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  } else if (a > 0) {
    const da = png.data[i + 3] / 255;
    const sa = a / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    png.data[i] = Math.round((r * sa + png.data[i] * da * (1 - sa)) / outA);
    png.data[i + 1] = Math.round((g * sa + png.data[i + 1] * da * (1 - sa)) / outA);
    png.data[i + 2] = Math.round((b * sa + png.data[i + 2] * da * (1 - sa)) / outA);
    png.data[i + 3] = Math.round(outA * 255);
  }
}

function fillRect(png, x0, y0, w, h, rgba) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setPx(png, x, y, rgba);
  }
}

function fillEllipse(png, cx, cy, rx, ry, rgba) {
  const rxi = Math.max(1, Math.round(rx));
  const ryi = Math.max(1, Math.round(ry));
  for (let y = -ryi; y <= ryi; y++) {
    for (let x = -rxi; x <= rxi; x++) {
      if ((x * x) / (rxi * rxi) + (y * y) / (ryi * ryi) <= 1.05) {
        setPx(png, cx + x, cy + y, rgba);
      }
    }
  }
}

function outlineEllipse(png, cx, cy, rx, ry, rgba) {
  const rxi = Math.max(1, Math.round(rx));
  const ryi = Math.max(1, Math.round(ry));
  for (let y = -ryi; y <= ryi; y++) {
    for (let x = -rxi; x <= rxi; x++) {
      const d = (x * x) / (rxi * rxi) + (y * y) / (ryi * ryi);
      if (d <= 1.08 && d >= 0.72) setPx(png, cx + x, cy + y, rgba);
    }
  }
}

function fillCircle(png, cx, cy, r, rgba) {
  fillEllipse(png, cx, cy, r, r, rgba);
}

function line(png, x0, y0, x1, y1, rgba, thickness = 1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  const t = Math.max(1, thickness);
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (dx * i) / steps;
    const y = y0 + (dy * i) / steps;
    if (t === 1) setPx(png, x, y, rgba);
    else fillCircle(png, x, y, t / 2, rgba);
  }
}

function blit(src, dst, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (src.width * y + x) << 2;
      if (src.data[si + 3] === 0) continue;
      setPx(dst, dx + x, dy + y, [
        src.data[si],
        src.data[si + 1],
        src.data[si + 2],
        src.data[si + 3],
      ]);
    }
  }
}

// ─── Direction helpers ───────────────────────────────────────

/** Map local body x (negative = character's right when facing south) into screen. */
function projectX(localX, dir) {
  // Facing south: local +x is to the right on screen (character's left is -x)
  // We use: +localX = character's right arm side when facing camera (south).
  switch (dir) {
    case 's':
      return localX;
    case 'n':
      return -localX;
    case 'e':
      return localX * 0.35; // compressed depth; depth uses z
    case 'w':
      return -localX * 0.35;
    case 'se':
      return localX * 0.75;
    case 'sw':
      return -localX * 0.75;
    case 'ne':
      return -localX * 0.55;
    case 'nw':
      return localX * 0.55;
    default:
      return localX;
  }
}

function depthScale(dir) {
  // How much "forward" localZ pushes on screen Y (lower = closer to camera / south)
  switch (dir) {
    case 's':
      return 0.15;
    case 'n':
      return -0.12;
    case 'e':
    case 'w':
      return 0.05;
    case 'se':
    case 'sw':
      return 0.12;
    case 'ne':
    case 'nw':
      return -0.08;
    default:
      return 0;
  }
}

function sideView(dir) {
  return dir === 'e' || dir === 'w';
}

function backView(dir) {
  return dir === 'n' || dir === 'ne' || dir === 'nw';
}

function facingSign(dir) {
  // Which way the character faces for arm/leg lateral placement on screen
  if (dir === 'e' || dir === 'se' || dir === 'ne') return 1;
  if (dir === 'w' || dir === 'sw' || dir === 'nw') return -1;
  return 0;
}

// ─── Character drawing ───────────────────────────────────────

/**
 * Draw one pose into a cell.
 * @param {object} opts
 * @param {string} opts.dir
 * @param {'walk'|'idle'} opts.anim
 * @param {number} opts.frame
 * @param {object} opts.variant
 * @param {object} opts.pal
 */
function drawPose(opts) {
  const { dir, anim, frame, variant, pal } = opts;
  const png = createCell();
  clear(png);

  // Anchor: feet near y=80, center x=46 (matches manifest anchors)
  const originX = 46;
  const originY = 80;

  // Animation phase
  const walkPhase = anim === 'walk' ? (frame / WALK) * Math.PI * 2 : 0;
  const idlePhase = anim === 'idle' ? (frame / IDLE) * Math.PI * 2 : 0;

  // Gait: opposite leg/arm swing (kick amplitude tuned for walk-delta validation)
  const legSwing = anim === 'walk' ? Math.sin(walkPhase) : 0;
  const armSwing = anim === 'walk' ? Math.sin(walkPhase + Math.PI) * 0.75 : Math.sin(idlePhase) * 0.1;
  const bodyBob = anim === 'walk'
    ? Math.abs(Math.sin(walkPhase * 2)) * 1.6
    : Math.sin(idlePhase) * 0.9;
  const lean = variant.lean * (anim === 'walk' ? 1.2 : 0.6);

  const bobY = -bodyBob;
  const cx = originX + lean * 2 * facingSign(dir);
  const cy = originY + bobY;

  // Local limb offsets (character space: +x = character right)
  const leftLegKick = legSwing * 7;
  const rightLegKick = -legSwing * 7;
  const leftArmSwing = armSwing * 5;
  const rightArmSwing = -armSwing * 5;

  // Drawing order depends on facing: far limbs first
  const parts = buildParts({
    dir,
    pal,
    variant,
    cx,
    cy,
    leftLegKick,
    rightLegKick,
    leftArmSwing,
    rightArmSwing,
    walkPhase,
    idlePhase,
    anim,
  });

  // Sort by depth (far first)
  parts.sort((a, b) => a.z - b.z);
  for (const part of parts) part.draw(png);

  return png;
}

function buildParts(ctx) {
  const {
    dir, pal, variant, cx, cy,
    leftLegKick, rightLegKick, leftArmSwing, rightArmSwing,
    walkPhase, idlePhase, anim,
  } = ctx;
  const parts = [];
  const side = sideView(dir);
  const back = backView(dir);
  const fs = facingSign(dir);
  const zS = depthScale(dir);

  const put = (z, draw) => parts.push({ z, draw });

  // Helpers to map local body coords to screen
  const sx = (lx, lz = 0) => cx + projectX(lx, dir) + lz * (dir === 'e' ? 6 : dir === 'w' ? -6 : dir === 'se' || dir === 'ne' ? 3 : dir === 'sw' || dir === 'nw' ? -3 : 0);
  const sy = (ly, lz = 0) => cy + ly + lz * zS * 8;

  // Span helper: project both local edges so north/side flips stay centered.
  const spanX = (half, lz = 0, wave = 0) => {
    const a = sx(-half + wave, lz);
    const b = sx(half + wave, lz);
    const left = Math.min(a, b);
    const right = Math.max(a, b);
    return { left, width: Math.max(1, right - left) };
  };

  // ── Cloak (short starfield cape; keep compact so north views stay legible) ──
  if (variant.cloak) {
    const cloakZ = back ? 6 : -3;
    put(cloakZ, (png) => {
      const topY = sy(-46);
      const botY = sy(-14);
      const baseHalf = side ? 4 : back ? 6 : 6;
      const flare = side ? 2 : 4;
      for (let t = 0; t <= 1; t += 0.05) {
        const y = Math.round(topY + (botY - topY) * t);
        const half = baseHalf + flare * t * t;
        const wave = Math.sin((walkPhase || idlePhase) + t * 2.5) * (anim === 'walk' ? 0.6 : 0.25);
        const { left, width } = spanX(half, back ? 0.15 : 0.25, wave * 0.2);
        fillRect(png, Math.round(left), y, Math.round(width), 1, pal.cloak);
      }
      line(
        png,
        sx(-baseHalf, 0.2), topY + 3,
        sx(-baseHalf - flare + 1 + Math.sin(walkPhase) * 0.6, 0.2), botY,
        pal.cloakTrim, 1,
      );
      line(
        png,
        sx(baseHalf, 0.2), topY + 3,
        sx(baseHalf + flare - 1 + Math.sin(walkPhase + 1) * 0.6, 0.2), botY,
        pal.cloakTrim, 1,
      );
      setPx(png, Math.round(sx(-2, 0.25)), Math.round(sy(-32)), pal.trimGlow);
      setPx(png, Math.round(sx(3, 0.25)), Math.round(sy(-28)), pal.trim);
      setPx(png, Math.round(sx(0, 0.25)), Math.round(sy(-22)), pal.trimDim);
    });
  }

  // ── Legs (exaggerated kick so walk-motion validation + village read stay clear) ──
  const drawLeg = (sideSign, kick, zBase) => {
    put(zBase, (png) => {
      const hipX = sx(sideSign * (side ? 1.5 : 3.2), 0);
      const hipY = sy(-24);
      // Map kick into screen space for the facing
      let kickX = 0;
      let kickY = kick * 1.15;
      if (dir === 'e') { kickX = kick * 1.1; kickY = Math.abs(kick) * 0.2; }
      else if (dir === 'w') { kickX = -kick * 1.1; kickY = Math.abs(kick) * 0.2; }
      else if (dir === 'n') { kickY = -kick * 0.55; kickX = sideSign * Math.abs(kick) * 0.15; }
      else if (dir === 'se') { kickX = kick * 0.55; kickY = kick * 0.9; }
      else if (dir === 'sw') { kickX = -kick * 0.55; kickY = kick * 0.9; }
      else if (dir === 'ne') { kickX = -kick * 0.45; kickY = -kick * 0.35; }
      else if (dir === 'nw') { kickX = kick * 0.45; kickY = -kick * 0.35; }

      const kneeX = hipX + kickX * 0.55;
      const kneeY = hipY + 9 + Math.abs(kick) * 0.2;
      const footX = hipX + kickX;
      const footY = hipY + 20 + Math.max(0, -kickY * 0.08);

      line(png, hipX, hipY, kneeX, kneeY, pal.pants, 4);
      line(png, hipX, hipY, kneeX, kneeY, pal.pantsDark, 2);
      line(png, kneeX, kneeY, footX, footY - 3, pal.pants, 3.5);
      fillEllipse(png, footX, footY - 1, side ? 4 : 5, 3, pal.boot);
      fillRect(png, footX - (side ? 2 : 3), footY - 2, side ? 5 : 7, 3, pal.boot);
      setPx(png, footX + (sideSign > 0 ? 2 : -2), footY - 2, pal.bootHi);
    });
  };

  // Far leg first (painter's algorithm by z)
  if (fs > 0) {
    drawLeg(-1, leftLegKick, -2);
    drawLeg(1, rightLegKick, 2);
  } else if (fs < 0) {
    drawLeg(1, rightLegKick, -2);
    drawLeg(-1, leftLegKick, 2);
  } else {
    // S/N: put the back-swinging leg farther
    drawLeg(-1, leftLegKick, leftLegKick < rightLegKick ? -2 : 1);
    drawLeg(1, rightLegKick, rightLegKick < leftLegKick ? -2 : 1);
  }

  // ── Torso / coat ──
  put(0, (png) => {
    const top = sy(-50);
    const waist = sy(-26);
    const coatBot = sy(-26 + 14 * variant.coatLength);
    const halfTop = side ? 6 : 9;
    const halfBot = side ? 7 : 11;

    for (let y = top; y <= coatBot; y++) {
      const t = (y - top) / Math.max(1, coatBot - top);
      const half = halfTop + (halfBot - halfTop) * t;
      const { left, width } = spanX(half);
      fillRect(png, Math.round(left), Math.round(y), Math.round(width), 1, t > 0.55 ? pal.coatDark : pal.coat);
      if (!back && t > 0.15 && t < 0.7) {
        setPx(png, Math.round(sx(-half * 0.25)), Math.round(y), pal.coatMid);
      }
    }

    if (!back) {
      line(png, sx(-halfTop + 1), top + 3, sx(-2), waist - 2, pal.trimDim, 1);
      line(png, sx(halfTop - 1), top + 3, sx(2), waist - 2, pal.trimDim, 1);
      fillCircle(png, sx(0), sy(-40), 2, pal.trim);
      setPx(png, Math.round(sx(0)), Math.round(sy(-40)), pal.trimGlow);
      setPx(png, Math.round(sx(-4)), Math.round(sy(-36)), pal.trimGlow);
      setPx(png, Math.round(sx(5)), Math.round(sy(-34)), pal.trim);
      setPx(png, Math.round(sx(-2)), Math.round(sy(-30)), pal.trimDim);
    } else {
      line(png, sx(0), top + 2, sx(0), coatBot - 2, pal.coatDark, 1);
      setPx(png, Math.round(sx(-3)), Math.round(sy(-38)), pal.trimDim);
      setPx(png, Math.round(sx(3)), Math.round(sy(-36)), pal.trim);
    }

    line(png, sx(-halfTop), top, sx(-halfBot), coatBot, pal.outline, 1);
    line(png, sx(halfTop), top, sx(halfBot), coatBot, pal.outline, 1);

    const belt = spanX(halfBot - 1);
    fillRect(png, Math.round(belt.left), Math.round(waist - 1), Math.round(belt.width), 2, pal.coatDark);
    const buckle = spanX(2);
    fillRect(png, Math.round(buckle.left), Math.round(waist - 1), Math.round(buckle.width), 2, pal.trimDim);
  });

  // ── Satchel ──
  if (variant.satchel) {
    const bagSide = back ? 1 : -1; // hang on left hip when facing us
    put(3, (png) => {
      const bx = sx(bagSide * 9, 0.1);
      const by = sy(-22);
      fillRect(png, bx - 3, by, 7, 6, pal.satchel);
      fillRect(png, bx - 3, by, 7, 1, pal.satchelTrim);
      setPx(png, bx, by + 3, pal.trimDim);
      // strap
      line(png, sx(bagSide * 3), sy(-42), bx, by, pal.satchel, 1);
    });
  }

  // ── Arms ──
  const drawArm = (sideSign, swing, zBase) => {
    put(zBase, (png) => {
      const shX = sx(sideSign * (side ? 5 : 8), 0);
      const shY = sy(-46);
      let swingX = 0;
      let swingY = swing;
      if (dir === 'e') { swingX = swing; swingY = Math.abs(swing) * 0.2; }
      else if (dir === 'w') { swingX = -swing; swingY = Math.abs(swing) * 0.2; }
      else if (dir === 'n') { swingY = -swing * 0.3; }
      else if (dir === 'se') { swingX = swing * 0.4; swingY = swing * 0.7; }
      else if (dir === 'sw') { swingX = -swing * 0.4; swingY = swing * 0.7; }
      else if (dir === 'ne') { swingX = -swing * 0.35; swingY = -swing * 0.15; }
      else if (dir === 'nw') { swingX = swing * 0.35; swingY = -swing * 0.15; }

      const elX = shX + sideSign * (side ? 1 : 2) + swingX * 0.5;
      const elY = shY + 8;
      const handX = shX + sideSign * (side ? 1 : 1) + swingX;
      const handY = shY + 15 + swingY * 0.15;

      // sleeve
      line(png, shX, shY, elX, elY, pal.coat, 3.5);
      line(png, elX, elY, handX, handY - 1, pal.coatMid, 3);
      // cyan cuff
      fillCircle(png, handX, handY - 2, 2, pal.trimDim);
      // open hand (skin) — no weapon
      fillCircle(png, handX, handY, 2.2, pal.skin);
      setPx(png, handX, handY, pal.skinShade);
    });
  };

  if (fs >= 0) {
    drawArm(-1, leftArmSwing, -1);
    drawArm(1, rightArmSwing, 4);
  } else {
    drawArm(1, rightArmSwing, -1);
    drawArm(-1, leftArmSwing, 4);
  }

  // ── Head ──
  put(5, (png) => {
    const hx = Math.round(sx(0));
    const hy = Math.round(sy(-55));
    const headRx = side ? 5 : 6;
    const headRy = 6.5;

    // neck
    fillRect(png, hx - 2, hy + 4, 4, 5, pal.skinShade);

    // skull
    fillEllipse(png, hx, hy, headRx, headRy, pal.skin);
    if (!back) {
      fillEllipse(png, hx + (side ? fs : 1), hy + 1, headRx - 2, headRy - 2, pal.skinShade);
      fillEllipse(png, hx - (side ? 0 : 1), hy - 1, 3, 3, pal.skin);
    }

    // hair / headband
    if (variant.hairLong) {
      // cap of silver hair (not a full helmet oval)
      fillEllipse(png, hx, hy - 3, headRx + 0.5, 4.5, pal.hair);
      fillEllipse(png, hx - 1, hy - 4, headRx - 1, 2.5, pal.hairShade);
      // side locks only, short
      fillRect(png, hx - headRx, hy - 1, 2, 6, pal.hair);
      fillRect(png, hx + headRx - 1, hy - 1, 2, 6, pal.hairShade);
      // cyan lightning streak
      const streakX = back ? hx - 2 : hx + 2;
      line(png, streakX, hy - 6, streakX + (back ? -1 : 1), hy + 0, pal.streak, 1);
      setPx(png, streakX, hy - 5, pal.trimGlow);
      // tiny fringe
      if (!back) fillRect(png, hx - 3, hy - 2, 6, 1, pal.hair);
    } else {
      fillEllipse(png, hx, hy - 3, headRx, 3.5, pal.hair);
      if (variant.headband) {
        fillRect(png, hx - headRx, hy - 1, headRx * 2, 2, pal.headband || pal.trim);
        setPx(png, hx, hy - 1, pal.trimGlow);
      }
    }

    // face
    if (!back) {
      if (side) {
        const ex = hx + fs * 2;
        setPx(png, ex, hy, pal.eye);
        setPx(png, ex, hy - 1, pal.eyeGlow);
        line(png, hx + fs * 1, hy + 3, hx + fs * 3, hy + 2, pal.outline, 1);
      } else {
        setPx(png, hx - 2, hy, pal.eye);
        setPx(png, hx + 2, hy, pal.eye);
        setPx(png, hx - 2, hy - 1, pal.eyeGlow);
        setPx(png, hx + 2, hy - 1, pal.eyeGlow);
        // smirk
        line(png, hx - 2, hy + 3, hx + 3, hy + 2, pal.outline, 1);
      }
    }

    outlineEllipse(png, hx, hy, headRx + 0.4, headRy + 0.4, pal.outline);
  });

  // ── Orbiting star mote ──
  put(9, (png) => {
    const phase = anim === 'walk' ? walkPhase : idlePhase;
    const ox = sx(Math.cos(phase) * 11, 0.3);
    const oy = sy(-52 + Math.sin(phase) * 4);
    fillCircle(png, ox, oy, 2, pal.moteCore);
    setPx(png, ox, oy, pal.mote);
    // sparkle cross
    setPx(png, ox + 2, oy, pal.trimGlow);
    setPx(png, ox - 2, oy, pal.trimGlow);
    setPx(png, ox, oy + 2, pal.trimGlow);
    setPx(png, ox, oy - 2, pal.trimGlow);
  });

  return parts;
}

// ─── Sheet assembly ──────────────────────────────────────────

function buildSheet(variantKey) {
  const variant = VARIANTS[variantKey];
  const pal = PALETTES[variant.palette];
  const sheet = new PNG({ width: CELL * COLS, height: CELL * ROWS, colorType: 6 });
  sheet.data.fill(0);

  for (let col = 0; col < COLS; col++) {
    const dir = DIRS[col];
    // walk rows 0..5
    for (let f = 0; f < WALK; f++) {
      const cell = drawPose({ dir, anim: 'walk', frame: f, variant, pal });
      blit(cell, sheet, col * CELL, f * CELL);
    }
    // idle rows 6..9
    for (let f = 0; f < IDLE; f++) {
      const cell = drawPose({ dir, anim: 'idle', frame: f, variant, pal });
      blit(cell, sheet, col * CELL, (WALK + f) * CELL);
    }
  }
  return sheet;
}

function writePng(png, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, PNG.sync.write(png));
}

function writePreviewStrip(variantKey) {
  const variant = VARIANTS[variantKey];
  const pal = PALETTES[variant.palette];
  // 8 dirs of walk0 + walk2, scaled later by caller if needed
  const strip = new PNG({ width: CELL * COLS, height: CELL * 2, colorType: 6 });
  strip.data.fill(0);
  for (let col = 0; col < COLS; col++) {
    const dir = DIRS[col];
    blit(drawPose({ dir, anim: 'walk', frame: 0, variant, pal }), strip, col * CELL, 0);
    blit(drawPose({ dir, anim: 'walk', frame: 2, variant, pal }), strip, col * CELL, CELL);
  }
  const out = join(repoRoot, 'output', `grok-procedural-preview-${variantKey}.png`);
  writePng(strip, out);
  console.log(`preview ${out}`);
}

// ─── Main ────────────────────────────────────────────────────

function main() {
  const ids = onlyId ? [onlyId] : Object.keys(VARIANTS);
  for (const id of ids) {
    if (!VARIANTS[id]) {
      console.error(`Unknown id ${id}. Known: ${Object.keys(VARIANTS).join(', ')}`);
      process.exit(1);
    }
    const sheet = buildSheet(id);
    const outPath = join(spritesRoot, id, 'sheet.png');
    writePng(sheet, outPath);
    console.log(`wrote ${outPath} (${sheet.width}×${sheet.height})`);
    if (writePreview) writePreviewStrip(id);
  }
}

main();
