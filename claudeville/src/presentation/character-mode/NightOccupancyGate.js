export const MIDNIGHT_OIL_RISE_MS = 400;
export const MIDNIGHT_OIL_FALL_MS = 1600;

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

export function nightWindowGate(phase, phaseProgress = 0) {
    if (phase === 'night') return 1;
    if (phase !== 'dusk') return 0;
    const progress = clamp01(phaseProgress);
    if (progress <= 0.8) return 0;
    if (progress >= 1) return 1;
    return (progress - 0.8) / 0.2;
}

export function lightsBuildingWindows(agent) {
    if (!agent || agent.isDeparted === true) return false;
    const departedAt = Number(agent.departedAt);
    if (Number.isFinite(departedAt) && departedAt !== 0) return false;
    return agent.status === 'working' || agent.turnState === 'tool_pending';
}

export function buildingEmissiveGate(phase, phaseProgress, workingFactor) {
    const night = nightWindowGate(phase, phaseProgress);
    return 1 + (clamp01(workingFactor) - 1) * night;
}

export function advanceNightOccupancyGate(value, target, dt, motionScale = 1) {
    const from = clamp01(value);
    const to = clamp01(target);
    if (!(Number(motionScale) > 0) || from === to) return to;
    const duration = to > from ? MIDNIGHT_OIL_RISE_MS : MIDNIGHT_OIL_FALL_MS;
    const delta = Math.max(0, Number(dt) || 0) / duration;
    if (delta + Number.EPSILON >= Math.abs(to - from)) return to;
    return to > from
        ? Math.min(to, from + delta)
        : Math.max(to, from - delta);
}
