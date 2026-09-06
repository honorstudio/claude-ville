const DEFAULT_PULSE_PRIORITY = ['selection', 'working', 'recent', 'intrinsic'];
const DEFAULT_PULSE_BANDS = Object.freeze({
    selection: { rate: 0.115, base: 0.72, amplitude: 0.28, phase: 0 },
    working: { rate: 0.075, base: 0.64, amplitude: 0.22, phase: 0.7 },
    recent: { rate: 0.045, base: 0.58, amplitude: 0.18, phase: 1.4 },
    alert: { rate: 0.145, base: 0.68, amplitude: 0.30, phase: 0.2 },
    harbor: { rate: 0.065, base: 0.62, amplitude: 0.20, phase: 1.1 },
    intrinsic: { rate: 0.035, base: 0.55, amplitude: 0.14, phase: 2.0 },
});

function parsePriority(value) {
    if (!value) return null;
    const parts = String(value)
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
    return parts.length ? parts : null;
}

export function getPulsePriority() {
    if (typeof window === 'undefined') return [...DEFAULT_PULSE_PRIORITY];
    try {
        const params = new URLSearchParams(window.location.search);
        return parsePriority(params.get('pulsePriority')) || [...DEFAULT_PULSE_PRIORITY];
    } catch {
        return [...DEFAULT_PULSE_PRIORITY];
    }
}

/*
 * Legacy frame-domain helpers remain only for callers not yet migrated to the
 * shared MotionClock. New code must use the millisecond-domain twins, and no
 * subsystem may keep a private frame counter.
 */
export function pulseValue(bandName = 'intrinsic', frame = 0, motionScale = 1) {
    const band = DEFAULT_PULSE_BANDS[bandName] || DEFAULT_PULSE_BANDS.intrinsic;
    if (motionScale <= 0) return band.base;
    const phase = (Number(frame) || 0) * band.rate + band.phase;
    return band.base + Math.sin(phase) * band.amplitude;
}

// Normalized 0..1 frame-domain read. This is the frame-counter counterpart to
// pulseBand01(); it lets existing renderers migrate without converting their
// clocks to milliseconds or changing a band's authored cadence. `phase`
// detunes individual marks while the reduced-motion result remains fixed.
export function pulseBand01Frame(bandName = 'intrinsic', frame = 0, motionScale = 1, phase = 0) {
    const band = DEFAULT_PULSE_BANDS[bandName] || DEFAULT_PULSE_BANDS.intrinsic;
    if (motionScale <= 0) return 0.5;
    const resolvedPhase = (Number(frame) || 0) * band.rate
        + band.phase
        + (Number(phase) || 0);
    return Math.max(0, Math.min(1, 0.5 + Math.sin(resolvedPhase) * 0.5));
}

// Millisecond-domain twin of pulseValue() for overlay modules that track
// performance.now() instead of a frame counter (plan 3.9 — snapping the local
// sine cadences onto shared bands). Converts ms to frames so the authored
// band rates keep their intended cadence; `phase` detunes individual marks
// sharing one band so neighbours do not pulse in lockstep.
export function pulseValueMs(bandName = 'intrinsic', nowMs = 0, motionScale = 1, phase = 0) {
    const band = DEFAULT_PULSE_BANDS[bandName] || DEFAULT_PULSE_BANDS.intrinsic;
    if (motionScale <= 0) return band.base;
    const frames = (Number(nowMs) || 0) / (1000 / 60);
    return band.base + Math.sin(frames * band.rate + band.phase + (Number(phase) || 0)) * band.amplitude;
}

export function pulseValueFromClock(bandName = 'intrinsic', clock, motionScale = 1, phase = 0) {
    return pulseValueMs(bandName, clock?.elapsedMs, motionScale, phase);
}

// Normalized 0..1 read of a band (base±amplitude mapped to 0..1), for callers
// replacing a legacy `0.5 + Math.sin(now / speed) * 0.5` cadence. Reduced
// motion returns 0.5 — the same static mid-value those cadences used.
export function pulseBand01(bandName = 'intrinsic', nowMs = 0, motionScale = 1, phase = 0) {
    const band = DEFAULT_PULSE_BANDS[bandName] || DEFAULT_PULSE_BANDS.intrinsic;
    if (motionScale <= 0) return 0.5;
    const span = Math.max(1e-6, band.amplitude * 2);
    const value = pulseValueMs(bandName, nowMs, motionScale, phase);
    return Math.max(0, Math.min(1, (value - (band.base - band.amplitude)) / span));
}

export function pulseAlpha(bandName = 'intrinsic', frame = 0, motionScale = 1, min = 0, max = 1) {
    const value = Math.max(0, Math.min(1, pulseValue(bandName, frame, motionScale)));
    const lo = Math.max(0, Math.min(1, Number(min) || 0));
    const hi = Math.max(lo, Math.min(1, Number(max) || 1));
    return lo + (hi - lo) * value;
}
