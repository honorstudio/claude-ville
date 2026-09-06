import { eventBus } from '../domain/events/DomainEvent.js';
import { actionableAgents } from '../domain/services/SignalLedger.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';
import { getActiveChronicleLog } from './ChronicleLog.js';

// The village is meant to be watched from the corner of the eye, which means
// the one thing it must be able to do is reach someone who is not looking at
// it. Everything here is that: the tab title, the favicon, a cue, and a way to
// get from "something needs you" to "I am looking at it" in one keystroke.

const BASE_TITLE = 'ClaudeVille - Agent Visualization';
const FAVICON_IDLE = 'favicon.svg';
const FAVICON_ALERT = 'favicon-alert.svg';
const DESKTOP_ALERTS_KEY = 'claudeville.alerts.desktop';

// A short tab switch is not an unattended session. One minute is long enough
// to represent a real absence while avoiding a digest for a quick glance at
// another window.
export const UNATTENDED_DIGEST_THRESHOLD_MS = 60_000;
export const UNATTENDED_DIGEST_MIN_AWAY_MS = UNATTENDED_DIGEST_THRESHOLD_MS;
export const UNATTENDED_DIGEST_EVENT = 'attention:digest';
export const ATTENTION_DIGEST_EVENT = UNATTENDED_DIGEST_EVENT;

const DIGEST_NAME_LIMIT = 3;
const DESKTOP_NOTIFICATION_MATCH_GRACE_MS = 5_000;

const REASON_TEXT = {
    question: 'asked you a question',
    approval: 'is waiting for approval',
    plan_review: 'wants you to review a plan',
};

function attentionLabel(agent) {
    if (agent?.status === AgentStatus.ERRORED) return 'hit an error';
    if (agent?.status === AgentStatus.RATE_LIMITED) return 'is rate limited';
    const reason = REASON_TEXT[agent?.waitReason];
    if (reason) return reason;
    return 'is waiting for you';
}

function attentionSummary(agents, now = Date.now()) {
    let oldestAwaitingSince = Infinity;
    for (const agent of agents) {
        const awaitingSince = Number(agent?.awaitingSince);
        if (!Number.isFinite(awaitingSince) || awaitingSince <= 0) continue;
        oldestAwaitingSince = Math.min(oldestAwaitingSince, awaitingSince);
    }

    return {
        waitingCount: agents.length,
        oldestWaitMs: oldestAwaitingSince === Infinity
            ? 0
            : Math.max(0, now - oldestAwaitingSince),
    };
}

function attentionEventKind(value) {
    const raw = value?.kind || value?.status;
    if (raw === AgentStatus.WAITING_ON_USER || raw === 'waiting') return 'waiting';
    if (raw === AgentStatus.ERRORED || raw === 'errored') return 'errored';
    if (raw === AgentStatus.RATE_LIMITED || raw === 'rate_limited') return 'rate_limited';
    return raw ? String(raw) : '';
}

function attentionNotificationKey(value) {
    const agentId = value?.agentId || value?.id;
    const kind = attentionEventKind(value);
    if (!agentId || !kind) return null;
    return `${agentId}\u0000${kind}`;
}

function nowFrom(clock) {
    const value = Number(clock?.());
    return Number.isFinite(value) ? value : Date.now();
}

function digestItems(digest, field, urgentField) {
    const urgent = digest?.urgent?.[urgentField];
    if (Array.isArray(urgent)) return urgent;
    return Array.isArray(digest?.[field]) ? digest[field] : [];
}

function digestCount(digest, preferred, fallback) {
    const unresolvedValue = Number(digest?.unresolved?.[preferred]);
    if (Number.isFinite(unresolvedValue)) return Math.max(0, unresolvedValue);
    const value = Number(digest?.[preferred]);
    if (Number.isFinite(value)) return Math.max(0, value);
    const nestedValue = Number(digest?.routine?.[preferred]);
    if (Number.isFinite(nestedValue)) return Math.max(0, nestedValue);
    const fallbackValue = Number(digest?.[fallback]);
    return Number.isFinite(fallbackValue) ? Math.max(0, fallbackValue) : 0;
}

function displayNames(items) {
    const names = [];
    const seen = new Set();
    for (const item of items || []) {
        if (item?.desktopNotified) continue;
        const name = String(item?.agentName || '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    if (!names.length) return '';
    const visible = names.slice(0, DIGEST_NAME_LIMIT);
    return names.length > DIGEST_NAME_LIMIT
        ? `${visible.join(', ')} +${names.length - DIGEST_NAME_LIMIT}`
        : visible.join(', ');
}

function appendNames(text, items) {
    const names = displayNames(items);
    return names ? `${text} (${names})` : text;
}

/** Turn a Chronicle interval rollup into one short, priority-ordered line. */
export function formatUnattendedDigest(digest) {
    const waiting = digestItems(digest, 'waiting', 'waiting');
    const errors = digestItems(digest, 'errorAgents', 'errors');
    const rateLimits = digestItems(digest, 'rateLimitAgents', 'rateLimits');
    const waitingCount = digestCount(digest, 'waitingAgents', 'waits');
    const errorCount = digestCount(digest, 'errorAgentCount', 'errors');
    const rateLimitCount = digestCount(digest, 'rateLimitAgentCount', 'rateLimits');

    const sections = [];
    if (waitingCount > 0) {
        const label = waitingCount === 1 ? '1 agent needs attention' : `${waitingCount} agents need attention`;
        sections.push(appendNames(label, waiting));
    }
    if (errorCount > 0) {
        const label = errorCount === 1 ? '1 error' : `${errorCount} errors`;
        sections.push(appendNames(label, errors));
    }
    if (rateLimitCount > 0) {
        const label = rateLimitCount === 1 ? '1 rate limit' : `${rateLimitCount} rate limits`;
        sections.push(appendNames(label, rateLimits));
    }

    const completed = digestCount(digest, 'completed', 'routine');
    const commits = digestCount(digest, 'commits', 'routine');
    const pushes = digestCount(digest, 'pushes', 'routine');
    const arrivals = digestCount(digest, 'arrivals', 'routine');
    const departures = digestCount(digest, 'departures', 'routine');
    const resolved = digestCount(digest, 'resolved', 'routine');
    if (completed > 0) sections.push(`${completed} ${completed === 1 ? 'completion' : 'completions'}`);
    if (commits > 0) {
        let text = `${commits} ${commits === 1 ? 'commit' : 'commits'}`;
        const labels = (digest?.commitDetails || [])
            .map(item => String(item?.label || '').trim().slice(0, 72))
            .filter(Boolean)
            .slice(0, 2);
        if (labels.length) text += ` (${labels.join('; ')})`;
        sections.push(text);
    }
    if (pushes > 0) sections.push(`${pushes} ${pushes === 1 ? 'push' : 'pushes'}`);
    if (arrivals > 0) sections.push(`${arrivals} ${arrivals === 1 ? 'arrival' : 'arrivals'}`);
    if (departures > 0) sections.push(`${departures} ${departures === 1 ? 'departure' : 'departures'}`);
    if (resolved > 0) sections.push(`${resolved} ${resolved === 1 ? 'wait resolved' : 'waits resolved'}`);

    if (!sections.length) return '';
    return `While you were away: ${sections.join('; ')}.`;
}

export class AttentionService {
    constructor(world, {
        toast = null,
        document: doc = null,
        NotificationClass = null,
        chronicleLog = null,
        window: windowRef = null,
        now = () => Date.now(),
        unattendedDigestThresholdMs = UNATTENDED_DIGEST_THRESHOLD_MS,
    } = {}) {
        this.world = world;
        this.toast = toast;
        this.doc = doc || (typeof document !== 'undefined' ? document : null);
        this.window = windowRef || globalThis.window || null;
        this._clock = typeof now === 'function' ? now : () => Date.now();
        this.unattendedDigestThresholdMs = Number.isFinite(Number(unattendedDigestThresholdMs))
            ? Math.max(1, Number(unattendedDigestThresholdMs))
            : UNATTENDED_DIGEST_THRESHOLD_MS;
        this._chronicleLogExplicit = Boolean(chronicleLog);
        this.chronicleLog = chronicleLog || getActiveChronicleLog?.() || null;
        this.NotificationClass = NotificationClass
            || (typeof Notification !== 'undefined' ? Notification : null);
        this.desktopAlerts = this._readDesktopAlertsPref();

        this._known = new Set();       // agent ids currently needing a person
        this._notifications = new Map(); // agent id -> owned desktop notification
        this._cursor = 0;              // rotation position for focusNext()
        this._faviconEl = null;
        this._destroyed = false;
        this._desktopAlertRequest = 0;
        this._desktopNotificationTimes = new Map();
        this._awaySince = null;
        this._digestGeneration = 0;

        this._onChronicleReady = (log) => {
            if (!this._chronicleLogExplicit && log?.readDigest) this.chronicleLog = log;
        };
        this._onChronicleStopped = (log) => {
            if (!this._chronicleLogExplicit && this.chronicleLog === log) this.chronicleLog = null;
        };
        eventBus.on('chronicle:log-ready', this._onChronicleReady);
        eventBus.on('chronicle:log-stopped', this._onChronicleStopped);

        this._onVisibilityChange = () => {
            if (this.doc?.visibilityState === 'hidden') this._markAway();
            else this._returnFromAway();
        };
        this._onWindowBlur = () => {
            if (this.doc?.visibilityState !== 'hidden') this._markAway();
        };
        this._onWindowFocus = () => {
            if (this.doc?.visibilityState !== 'hidden') this._returnFromAway();
        };
        this.doc?.addEventListener?.('visibilitychange', this._onVisibilityChange);
        this.window?.addEventListener?.('blur', this._onWindowBlur);
        this.window?.addEventListener?.('focus', this._onWindowFocus);
        if (this.doc?.visibilityState === 'hidden') this._markAway();

        this._onWorldChanged = () => this.refresh();
        eventBus.on('agent:added', this._onWorldChanged);
        eventBus.on('agent:updated', this._onWorldChanged);
        eventBus.on('agent:removed', this._onWorldChanged);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._desktopAlertRequest++;
        this._digestGeneration++;
        eventBus.off('agent:added', this._onWorldChanged);
        eventBus.off('agent:updated', this._onWorldChanged);
        eventBus.off('agent:removed', this._onWorldChanged);
        eventBus.off('chronicle:log-ready', this._onChronicleReady);
        eventBus.off('chronicle:log-stopped', this._onChronicleStopped);
        this.doc?.removeEventListener?.('visibilitychange', this._onVisibilityChange);
        this.window?.removeEventListener?.('blur', this._onWindowBlur);
        this.window?.removeEventListener?.('focus', this._onWindowFocus);
        this._closeAllNotifications();
        this._desktopNotificationTimes.clear();
        this._awaySince = null;
        this.chronicleLog = null;
        this._known.clear();
        this._setTitle(0);
        this._setFavicon(false);
    }

    /** Agents needing a person, longest-waiting first. */
    list() {
        return actionableAgents(this.world);
    }

    refresh() {
        if (this._destroyed) return;
        const agents = this.list();
        const ids = new Set(agents.map(agent => agent.id));
        const summary = attentionSummary(agents);

        for (const agent of agents) {
            if (this._known.has(agent.id)) continue;
            this._raise(agent, summary);
        }
        for (const id of this._known) {
            if (!ids.has(id)) {
                this._closeNotification(id);
                eventBus.emit('attention:cleared', { agentId: id });
            }
        }
        this._known = ids;

        this._setTitle(agents.length);
        this._setFavicon(agents.length > 0);
    }

    _raise(agent, { waitingCount, oldestWaitMs } = attentionSummary([agent])) {
        const label = attentionLabel(agent);
        eventBus.emit('attention:raised', {
            agentId: agent.id,
            status: agent.status,
            label,
            agent,
            reason: agent.waitReason || agent.status || null,
            waitingCount,
            oldestWaitMs,
        });
        this.toast?.show(`${agent.name} ${label}`, 'warning');
        this._notify(agent, label);
    }

    _selectAgent(agentOrId) {
        const agent = agentOrId && typeof agentOrId === 'object'
            ? agentOrId
            : this.world?.agents?.get?.(agentOrId);
        if (agent) eventBus.emit('agent:selected', agent);
        return agent;
    }

    /**
     * Select and follow the next agent needing attention. Returns the agent it
     * moved to, or null when the village is calm.
     */
    focusNext() {
        const agents = this.list();
        if (!agents.length) return null;
        const agent = agents[this._cursor % agents.length];
        this._cursor = (this._cursor + 1) % agents.length;
        this._selectAgent(agent);
        return agent;
    }

    _markAway() {
        if (this._awaySince !== null) return;
        this._awaySince = nowFrom(this._clock);
    }

    _returnFromAway() {
        if (this._awaySince === null) return;
        const since = this._awaySince;
        this._awaySince = null;
        const until = nowFrom(this._clock);
        const awayMs = Math.max(0, until - since);
        if (awayMs < this.unattendedDigestThresholdMs) return;
        void this._emitUnattendedDigest({ since, until, awayMs });
    }

    async _emitUnattendedDigest({ since, until, awayMs }) {
        const log = this.chronicleLog || getActiveChronicleLog?.();
        if (!log || typeof log.readDigest !== 'function') return;
        const generation = ++this._digestGeneration;
        try {
            const digest = await log.readDigest(since, until);
            if (this._destroyed || generation !== this._digestGeneration) return;
            // A return/focus event can race with a second hide. Do not place a
            // stale digest into a tab that is no longer visible.
            if (this.doc?.visibilityState === 'hidden') return;
            const summary = this._decorateDigest(digest, since, until);
            const message = formatUnattendedDigest(summary);
            if (!message) return;

            const payload = {
                kind: 'unattended-digest',
                message,
                type: summary.hasUrgent ? 'warning' : 'info',
                since,
                until,
                awayMs,
                summary,
            };
            eventBus.emit(UNATTENDED_DIGEST_EVENT, payload);
            // Keep the feature visible with the current Toast implementation;
            // the event above is the presentation contract for richer toast
            // renderers and test harnesses.
            this.toast?.show?.(message, payload.type);
        } catch {
            // A missing/closed Chronicle must never interfere with attention.
        }
    }

    _decorateDigest(digest, since, until) {
        const waitingCount = digestCount(digest, 'waitingAgents', 'waits');
        const errorCount = digestCount(digest, 'errorAgentCount', 'errors');
        const rateLimitCount = digestCount(digest, 'rateLimitAgentCount', 'rateLimits');
        // Chronicle supplies these as net state counts. Do not decorate stale
        // entry arrays when a condition was resolved later in the interval.
        const waiting = waitingCount > 0
            ? digestItems(digest, 'waiting', 'waiting')
                .map(item => this._decorateDigestItem(item, since, until))
            : [];
        const errors = errorCount > 0
            ? digestItems(digest, 'errorAgents', 'errors')
                .map(item => this._decorateDigestItem(item, since, until))
            : [];
        const rateLimits = rateLimitCount > 0
            ? digestItems(digest, 'rateLimitAgents', 'rateLimits')
                .map(item => this._decorateDigestItem(item, since, until))
            : [];
        const desktopNotifiedCount = [...waiting, ...errors, ...rateLimits]
            .filter(item => item.desktopNotified).length;
        const hasUrgent = waitingCount > 0 || errorCount > 0 || rateLimitCount > 0;
        return {
            ...(digest || {}),
            waiting,
            errorAgents: errors,
            rateLimitAgents: rateLimits,
            waitingAgents: waitingCount,
            errorAgentCount: errorCount,
            rateLimitAgentCount: rateLimitCount,
            unresolved: {
                ...(digest?.unresolved || {}),
                waitingAgents: waitingCount,
                errorAgentCount: errorCount,
                rateLimitAgentCount: rateLimitCount,
            },
            urgent: { waiting, errors, rateLimits },
            hasUrgent,
            desktopNotifiedCount,
        };
    }

    _decorateDigestItem(item, since, until) {
        return {
            ...(item || {}),
            desktopNotified: this._wasDesktopNotified(item, since, until),
        };
    }

    _wasDesktopNotified(event, since, until) {
        const key = attentionNotificationKey(event);
        if (!key) return false;
        const sentAt = this._desktopNotificationTimes.get(key);
        if (!Number.isFinite(sentAt)) return false;
        return sentAt >= since - DESKTOP_NOTIFICATION_MATCH_GRACE_MS
            && sentAt <= until + DESKTOP_NOTIFICATION_MATCH_GRACE_MS;
    }

    // ─── Desktop notifications (opt-in, user gesture only) ───────────────

    get desktopAlertsAvailable() {
        return !!this.NotificationClass;
    }

    /**
     * Toggle desktop notifications. Must be called from a user gesture —
     * browsers reject permission prompts otherwise, and asking unbidden is
     * exactly the kind of nagging this app is supposed to avoid.
     */
    async setDesktopAlerts(enabled) {
        const request = ++this._desktopAlertRequest;
        if (!enabled) {
            this.desktopAlerts = false;
            this._writeDesktopAlertsPref(false);
            this._closeAllNotifications();
            return false;
        }
        if (!this.desktopAlertsAvailable) {
            this.desktopAlerts = false;
            this._writeDesktopAlertsPref(false);
            this._closeAllNotifications();
            return false;
        }
        let permission = this.NotificationClass.permission;
        if (permission === 'default') {
            try {
                permission = await this.NotificationClass.requestPermission();
            } catch {
                permission = 'denied';
            }
        }
        if (this._destroyed || request !== this._desktopAlertRequest) return false;
        this.desktopAlerts = permission === 'granted';
        this._writeDesktopAlertsPref(this.desktopAlerts);
        if (!this.desktopAlerts) this._closeAllNotifications();
        return this.desktopAlerts;
    }

    _notify(agent, label) {
        if (this._destroyed || !this.desktopAlerts || !this.desktopAlertsAvailable) return;
        if (this.NotificationClass.permission !== 'granted') return;
        // Only speak up when nobody is looking at the village.
        if (this.doc && this.doc.visibilityState === 'visible') return;
        const agentId = agent.id;
        this._closeNotification(agentId);
        try {
            const note = new this.NotificationClass(`${agent.name} ${label}`, {
                body: agent.projectPath || 'ClaudeVille',
                tag: `claudeville-${agentId}`,
                icon: FAVICON_ALERT,
            });
            this._notifications.set(agentId, note);
            note.onclose = () => {
                if (this._notifications.get(agentId) === note) {
                    this._notifications.delete(agentId);
                }
            };
            note.onclick = () => {
                try { window.focus(); } catch { /* no-op */ }
                this._selectAgent(agentId);
                this._closeNotification(agentId);
            };
            this._rememberDesktopNotification(agent);
            return true;
        } catch { /* notifications are best effort */ }
        return false;
    }

    _rememberDesktopNotification(agent) {
        const key = attentionNotificationKey(agent);
        if (!key) return;
        this._desktopNotificationTimes.set(key, nowFrom(this._clock));
        while (this._desktopNotificationTimes.size > 256) {
            this._desktopNotificationTimes.delete(this._desktopNotificationTimes.keys().next().value);
        }
    }

    _closeNotification(agentId) {
        const note = this._notifications.get(agentId);
        if (!note) return;
        this._notifications.delete(agentId);
        note.onclick = null;
        note.onclose = null;
        try { note.close(); } catch { /* notifications are best effort */ }
    }

    _closeAllNotifications() {
        for (const agentId of [...this._notifications.keys()]) {
            this._closeNotification(agentId);
        }
    }

    _readDesktopAlertsPref() {
        try { return localStorage.getItem(DESKTOP_ALERTS_KEY) === '1'; } catch { return false; }
    }

    _writeDesktopAlertsPref(value) {
        try { localStorage.setItem(DESKTOP_ALERTS_KEY, value ? '1' : '0'); } catch { /* no-op */ }
    }

    // ─── Tab marks ───────────────────────────────────────────────────────

    _setTitle(count) {
        if (!this.doc) return;
        this.doc.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
    }

    _setFavicon(alert) {
        if (!this.doc) return;
        if (!this._faviconEl) this._faviconEl = this.doc.querySelector('link[rel="icon"]');
        if (!this._faviconEl) return;
        const href = alert ? FAVICON_ALERT : FAVICON_IDLE;
        if (this._faviconEl.getAttribute('href') === href) return;
        this._faviconEl.setAttribute('href', href);
    }
}
