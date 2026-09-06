/**
 * C3 — one elapsed-millisecond clock for the whole village.
 *
 * Before this module, motion was counted in frames: camera follow applied a
 * fixed per-update lerp coefficient, the world water clock advanced by a
 * constant 0.03 per update despite `_loop` already computing a clamped dt, and
 * idle stride pauses were counted in update calls. All three ran at a
 * different real-world speed on a 120 Hz display than on a 60 Hz one.
 *
 * Every animated subsystem now derives its phase from elapsed milliseconds.
 * A virtual 60 Hz frame counter may be derived from the same clock so existing
 * frame-domain consumers keep their authored cadence, but no subsystem may
 * keep a second private clock.
 *
 * Pure: no DOM, no timers, no allocation beyond the caller's clock object.
 */

/** The reference frame duration the existing cadences were authored against. */
export const REF_DT_MS = 1000 / 60;

/**
 * A single very long frame (tab return, GC pause, breakpoint) must not
 * teleport the village. Callers already clamp dt; this is the backstop.
 */
export const MAX_DT_MS = 250;

/** Clamp a raw frame delta into a sane range. */
export function clampDt(dtMs, maxDtMs = MAX_DT_MS) {
    const dt = Number(dtMs);
    if (!Number.isFinite(dt) || dt <= 0) return 0;
    return Math.min(dt, maxDtMs);
}

/**
 * Convert a legacy per-frame lerp coefficient into its time constant.
 *
 * A per-frame `x += (target - x) * s` is exponential decay sampled at the
 * reference frame duration, so `tau = -refDt / ln(1 - s)`.
 */
export function smoothingToTau(perFrameSmoothing, refDtMs = REF_DT_MS) {
    const s = Number(perFrameSmoothing);
    if (!Number.isFinite(s) || s <= 0) return Infinity;
    if (s >= 1) return 0;
    return -refDtMs / Math.log(1 - s);
}

/**
 * The frame-rate-independent lerp factor equivalent to a legacy per-frame
 * coefficient. At `dtMs === refDtMs` this returns the original coefficient
 * exactly, so authored feel is preserved at 60 Hz while 30 Hz and 120 Hz
 * finally agree with it.
 */
export function dtAlpha(perFrameSmoothing, dtMs, refDtMs = REF_DT_MS) {
    const s = Number(perFrameSmoothing);
    if (!Number.isFinite(s) || s <= 0) return 0;
    if (s >= 1) return 1;
    const dt = clampDt(dtMs);
    if (dt === 0) return 0;
    const tau = smoothingToTau(s, refDtMs);
    if (!Number.isFinite(tau) || tau <= 0) return 1;
    return Math.min(1, 1 - Math.exp(-dt / tau));
}

/** A fresh clock. `virtualFrame` is derived, never independently advanced. */
export function createMotionClock() {
    return { elapsedMs: 0, virtualFrame: 0, lastDtMs: 0 };
}
/**
 * Advance a clock by one frame.
 *
 * Reduced motion (`motionScale <= 0`) freezes the clock in place: the village
 * holds a static tableau rather than running a second, slower animation.
 *
 * A fractional scale between 0 and 1 slows the clock proportionally, which
 * preserves the semantics of the per-frame accumulators this replaced (they
 * multiplied their step by `motionScale`). Returns the same object so callers
 * can chain without allocating.
 */
export function advanceMotionClock(clock, dtMs, motionScale = 1) {
    if (!clock) return createMotionClock();
    const scale = Number(motionScale);
    if (!Number.isFinite(scale) || scale <= 0) {
        clock.lastDtMs = 0;
        return clock;
    }
    const dt = clampDt(dtMs) * Math.min(1, scale);
    clock.lastDtMs = dt;
    clock.elapsedMs += dt;
    clock.virtualFrame = virtualFramesFor(clock.elapsedMs);
    return clock;
}

/** Elapsed milliseconds expressed as 60 Hz frames. */
export function virtualFramesFor(elapsedMs) {
    const ms = Number(elapsedMs);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return ms / REF_DT_MS;
}

/** 60 Hz frames expressed as milliseconds. */
export function msForVirtualFrames(frames) {
    const f = Number(frames);
    if (!Number.isFinite(f) || f <= 0) return 0;
    return f * REF_DT_MS;
}

/**
 * Where the clock sits inside a repeating duty cycle, as 0..1.
 *
 * Used to express an authored on/off cadence in real time instead of update
 * counts. The idle stroller's "hold the frame for 6 ticks out of every 12"
 * becomes a 200 ms period with a 0.5 pause fraction.
 */
export function dutyCyclePhase(elapsedMs, periodMs) {
    const period = Number(periodMs);
    if (!Number.isFinite(period) || period <= 0) return 0;
    const ms = Number(elapsedMs);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return (ms % period) / period;
}

/**
 * True while a duty cycle is in its paused leading fraction, matching the
 * original `phase < 6` of 12 test.
 */
export function inDutyPause(elapsedMs, periodMs, pauseFraction = 0.5) {
    const off = Number(pauseFraction);
    if (!Number.isFinite(off) || off <= 0) return false;
    if (off >= 1) return true;
    return dutyCyclePhase(elapsedMs, periodMs) < off;
}

/** The idle stroller's authored cadence: 6 paused ticks of every 12 at 60 Hz. */
export const IDLE_STRIDE_PERIOD_MS = 12 * REF_DT_MS;
export const IDLE_STRIDE_PAUSE_FRACTION = 0.5;
