import { astraWeaponPose } from './AstraWeaponPose.js';
import { DEFAULT_CELL } from './SpriteSheet.js';
import { CODEX_CELESTIAL_GRIPS } from './CodexCelestialGrips.js';
import { CODEX_PALADIN_GRIPS } from './CodexPaladinGrips.js';
import { CODEX_ENGINEER_GRIPS } from './CodexEngineerGrips.js';

export const CODEX_GRIP_PROFILES = {
    ...CODEX_CELESTIAL_GRIPS,
    ...CODEX_PALADIN_GRIPS,
    ...CODEX_ENGINEER_GRIPS,
};
const ASTRA_PALETTE = ['#171724', '#555569', '#a5b4c2', '#dce8ed'];

export function codexWeaponPose(spriteId, geometry, direction, equipment) {
    if (spriteId === 'agent.codex.gpt6astra') {
        const pose = astraWeaponPose(geometry, direction, equipment);
        return pose && { ...pose, backLayer: pose.behindBody || direction === 'n', palette: ASTRA_PALETTE };
    }
    const profile = CODEX_GRIP_PROFILES[spriteId];
    const wrist = profile?.wrists[direction]?.[geometry.cell?.sy / DEFAULT_CELL];
    if (!wrist) return null;
    const { dx, dy, drawScale = 1 } = geometry;
    return {
        x: dx + wrist[0] * drawScale,
        y: dy + wrist[1] * drawScale,
        flipX: profile.flipDirections.includes(direction),
        behindBody: profile.behindDirections.includes(direction),
        backLayer: profile.behindDirections.includes(direction) || profile.backDirections.includes(direction),
        angle: profile.angles[direction],
        scale: profile.scale,
        palette: profile.palette,
        gripScale: profile.gripScale || 1,
    };
}

export function drawCodexGauntlet(ctx, pose, drawScale) {
    ctx.save();
    ctx.translate(Math.round(pose.x), Math.round(pose.y));
    ctx.scale(drawScale, drawScale);
    const scale = pose.gripScale || 1;
    // Keep smaller gloves on the source pixel grid, including in GPU sheets.
    const rect = (x, y, w, h) => ctx.fillRect(Math.round(x * scale), Math.round(y * scale),
        Math.max(1, Math.round((x + w) * scale) - Math.round(x * scale)),
        Math.max(1, Math.round((y + h) * scale) - Math.round(y * scale)));
    const [outline, shadow, midtone, highlight] = pose.palette;
    // Unrotated cuff joins the authored forearm; fingers close over the hilt.
    ctx.fillStyle = outline;
    rect(-2, -4, 4, 7);
    rect(-3, -2, 6, 4);
    ctx.fillStyle = shadow;
    rect(-2, -3, 4, 6);
    ctx.fillStyle = midtone;
    rect(-2, -3, 4, 2);
    rect(-2, 0, 4, 2);
    ctx.fillStyle = highlight;
    rect(-2, -3, 3, 1);
    rect(-2, 0, 3, 1);
    ctx.restore();
}
