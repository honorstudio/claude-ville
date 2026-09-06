/**
 * Session residency.
 *
 * Adapters only report sessions touched inside ACTIVE_THRESHOLD_MS, which is
 * right for discovery but can hide a silent unresolved tool call. Completed
 * turns already have a shorter presentation-layer departure grace.
 *
 * Residency keeps unresolved tool calls after they leave the active window.
 * Completed turns use the browser's shorter departed-villager grace instead;
 * retaining them here as well stacked both lifecycles and filled the village
 * with finished sessions for nearly an hour. A session that vanished mid-work,
 * completed normally, or comes from a provider with no turn state is dropped:
 * silence there does not mean an unresolved tool still needs observation.
 */

const { classifyPendingTool } = require('../adapters/turnState');
const { HOOK_WAIT_RETENTION_MS } = require('../adapters/hooks');

const DEFAULT_TTL_MS = 45 * 60 * 1000;
const DEFAULT_MAX_RESIDENTS = 24;

const RETAINED_TURN_STATES = new Set(['tool_pending']);

class SessionResidency {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxResidents = DEFAULT_MAX_RESIDENTS } = {}) {
    this.ttlMs = ttlMs;
    this.maxResidents = maxResidents;
    this._residents = new Map(); // sessionId → { session, residentSince, lastLiveAt }
    this._stats = { admitted: 0, resumed: 0, expired: 0, capEvictions: 0 };
  }

  /**
   * Merge live adapter output with retained sessions.
   * @param {Array<object>} liveSessions
   * @returns {Array<object>} live sessions followed by still-valid residents
   */
  merge(liveSessions, now = Date.now()) {
    const live = Array.isArray(liveSessions) ? liveSessions : [];
    const liveIds = new Set();

    for (const session of live) {
      const id = session?.sessionId;
      if (!id) continue;
      liveIds.add(id);
      const previous = this._residents.get(id);
      // Only a session we were actually serving from residency counts as
      // resumed; refreshing a still-live retained session is not a resumption.
      if (previous?.absent) this._stats.resumed++;
      this._residents.delete(id);
      if (RETAINED_TURN_STATES.has(session.turnState) && session.freshness?.state !== 'stale') {
        if (!previous) this._stats.admitted++;
        this._residents.set(id, {
          session: { ...session },
          residentSince: previous?.residentSince ?? now,
          lastLiveAt: now,
          absent: false,
        });
      }
    }

    // Expire and cap before emitting, so an over-cap resident is never served
    // one last time on its way out.
    for (const [id, record] of [...this._residents]) {
      if (liveIds.has(id)) continue;
      const hookExpired = record.session.signalSource === 'hook' && record.session.waitReason
        && record.session.signalObservedAt != null && now - record.session.signalObservedAt >= HOOK_WAIT_RETENTION_MS;
      if (hookExpired || now - record.lastLiveAt > this.ttlMs) {
        this._residents.delete(id);
        this._stats.expired++;
      }
    }
    this._enforceCap(liveIds);

    const out = live.slice();
    for (const [id, record] of this._residents) {
      if (liveIds.has(id)) continue; // still live; the resident copy is only a backup
      record.absent = true;
      out.push(this._presentResident(record, now));
    }
    return out;
  }

  // A retained transcript is a last observation, never a new approval signal.
  _presentResident(record, now) {
    const session = {
      waitReason: null,
      awaitingSince: null,
      ...record.session,
      resident: true,
      signalStale: true,
      freshness: { state: 'stale', observedAt: record.session.freshness?.observedAt ?? record.lastLiveAt,
        ageMs: now - (record.session.freshness?.observedAt ?? record.lastLiveAt) },
    };
    if (session.turnState === 'tool_pending' && !session.waitReason) {
      const { blocked, reason } = classifyPendingTool({
        tool: session.pendingTool,
        permissionMode: session.permissionMode,
        pendingForMs: session.pendingSince ? Math.max(0, now - session.pendingSince) : 0,
      });
      if (blocked) {
        session.waitReason = reason;
        session.awaitingSince = session.pendingSince;
      }
    }
    return session;
  }

  _enforceCap(liveIds) {
    const evictable = [...this._residents.entries()].filter(([id]) => !liveIds.has(id));
    let overflow = evictable.length - this.maxResidents;
    if (overflow <= 0) return;
    evictable.sort((a, b) => a[1].lastLiveAt - b[1].lastLiveAt);
    for (const [id] of evictable) {
      if (overflow-- <= 0) break;
      this._residents.delete(id);
      this._stats.capEvictions++;
    }
  }

  get size() {
    return this._residents.size;
  }

  getDiagnostics() {
    return {
      residents: this._residents.size,
      ttlMs: this.ttlMs,
      maxResidents: this.maxResidents,
      ...this._stats,
    };
  }

  clear() {
    this._residents.clear();
  }
}

module.exports = {
  SessionResidency,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_RESIDENTS,
  RETAINED_TURN_STATES,
};
