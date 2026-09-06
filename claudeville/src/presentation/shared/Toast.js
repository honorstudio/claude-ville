import { eventBus } from '../../domain/events/DomainEvent.js';

const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 3000;
const MAX_CUE_CAPTIONS = 3;
const ROUTINE_CUE_DISMISS_MS = 4800;
const PRIMARY_CUE_DISMISS_MS = 8000;
// A digest summarises a whole absence, so it needs longer than any single cue.
const DIGEST_DISMISS_MS = 12000;
const CUE_CONTEXT_MAX_AGE_MS = 1500;
const ATTENTION_NOTICE_GRACE_MS = 1500;
const PRIMARY_CUES = new Set(['distress', 'summons']);

const CUE_PRESENTATION = Object.freeze({
    arrival: { action: 'arrived', type: 'info' },
    departure: { action: 'departed', type: 'info' },
    distress: { action: 'needs attention', type: 'error' },
    recovery: { action: 'recovered', type: 'success' },
    summons: { action: 'needs you', type: 'warning' },
});

const GLOBAL_CUE_COPY = Object.freeze({
    council: 'The team is gathering',
    hourBell: 'The hour bell is ringing',
    aurora: 'A village milestone was reached',
    thunder: 'Thunder nearby',
});

const ATTENTION_REASON_COPY = Object.freeze({
    question: 'asked you a question',
    approval: 'is waiting for approval',
    plan_review: 'wants you to review a plan',
    errored: 'hit an error',
    rate_limited: 'is rate limited',
});

function cleanLabel(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, 96);
}

// Cue captions are a few words; a digest summarises a whole absence and needs
// more room than cleanLabel's 96-character cue budget allows.
function cleanDigestMessage(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function labelAlreadyDescribesCue(label) {
    return /\b(arrived|departed|left|needs|waiting|distress|recovered|gathering|rang|ringing|reached|thunder|error|rate[- ]limited)\b/i.test(label);
}

function labelIsPredicate(label) {
    return /^(?:is|has|was|hit|reached)\b/i.test(label);
}

function attentionAgentId(payload) {
    const value = payload?.agentId ?? payload?.agent?.id;
    return value == null ? '' : cleanLabel(String(value));
}

function attentionNotice(payload, observedAgentLabel = '') {
    if (!payload || typeof payload !== 'object') return '';
    const name = cleanLabel(
        payload.agent?.name
        || payload.agent?.displayName
        || observedAgentLabel,
    );
    const label = cleanLabel(
        payload.label
        || ATTENTION_REASON_COPY[cleanLabel(payload.reason)]
        || ATTENTION_REASON_COPY[cleanLabel(payload.status)]
        || 'needs your attention',
    );
    if (!name) return labelIsPredicate(label) ? `An agent ${label}` : label;
    if (label.toLowerCase().startsWith(`${name.toLowerCase()} `)) return label;
    return `${name} ${label}`;
}

function isAttentionNotice(message) {
    return /\b(?:needs you|needs attention|asked you|waiting for you|waiting for approval|wants you|hit an error|rate[- ]limited)\b/i.test(message);
}

function attentionMessageSpecificity(message) {
    const text = cleanLabel(message);
    if (/\b(?:asked you|waiting for approval|review a plan|hit an error|rate[- ]limited)\b/i.test(text)) return 2;
    if (/\b(?:needs you|needs attention|waiting for you|wants you)\b/i.test(text)) return 1;
    return 0;
}

// Agent-scoped producers may send either a display name or a short reason.
// Prefer the locally observed name when available, while accepting complete
// producer copy without doubling its verb ("Aurora needs you needs you").
export function formatCueCaption(payload, observedAgentLabel = '') {
    if (!payload || typeof payload !== 'object') return '';
    const kind = cleanLabel(payload.kind);
    const label = cleanLabel(payload.label);
    const observedName = cleanLabel(observedAgentLabel);

    if (observedName && kind === 'summons' && labelIsPredicate(label)) {
        return `${observedName} ${label}`;
    }

    const presentation = CUE_PRESENTATION[kind];
    if (presentation) {
        const producerSuppliedCopy = label && labelAlreadyDescribesCue(label);
        if (observedName) return `${observedName} ${presentation.action}`;
        if (producerSuppliedCopy) {
            return labelIsPredicate(label) ? `An agent ${label}` : label;
        }
        return `${label || 'An agent'} ${presentation.action}`;
    }
    if (GLOBAL_CUE_COPY[kind]) return GLOBAL_CUE_COPY[kind];
    return label || '';
}

export class Toast {
    constructor({ eventTarget = eventBus, documentRef = globalThis.document } = {}) {
        this.documentRef = documentRef;
        this.container = documentRef?.getElementById?.('toastContainer') || null;
        this.toasts = [];
        this._destroyed = false;
        this._eventTarget = eventTarget;
        this._agentLabels = new Map();
        this._recentCueContext = new Map();
        this._eventUnsubscribes = [];
        const on = (event, handler) => {
            const unsubscribe = eventTarget?.on?.(event, handler);
            if (typeof unsubscribe === 'function') this._eventUnsubscribes.push(unsubscribe);
        };
        on('agent:added', agent => this._rememberAgentLabel(agent));
        on('agent:updated', agent => this._rememberAgentLabel(agent));
        // Keep the last label after removal so the ensuing departure cue can
        // still name its agent; the bounded cache prevents unbounded history.
        on('agent:removed', agent => this._rememberAgentLabel(agent));
        // AttentionService emits this before calling toast.show(). Claim the
        // specific event once here so the subsequent direct notice and the
        // summons caption share one live-region entry.
        on('attention:raised', payload => {
            this.showAttention(payload);
        });
        // Lifecycle audio is emitted synchronously from village scenes. Keep a
        // very short-lived context bridge for producers that use the contract's
        // nullable agentId and generic fallback label.
        on('village:scene', scene => this._rememberCueContext(scene));
        on('audio:cue-played', (payload) => {
            this.showCue(payload);
        });
        // The unattended digest reports what happened while the operator was away.
        // It is pre-composed by AttentionService; render it as a persistent primary
        // notice so it survives the cue traffic that arrives on return.
        on('attention:digest', (payload) => {
            this.showDigest(payload);
        });
        on('chronicle:read-failed', payload => {
            this.show(payload?.message || 'Could not load the Chronicle day.', 'warning');
        });
        on('chronicle:export-failed', payload => {
            this.show(payload?.message || 'Could not export the Chronicle.', 'warning');
        });
    }

    show(message, type = 'info') {
        if (this._destroyed || !this.container) return;

        const cleanMessage = cleanLabel(message);
        const collapsed = this._collapseDirectAttention(cleanMessage, type);
        if (collapsed) return collapsed;

        const agentId = isAttentionNotice(cleanMessage) ? this._agentIdForMessage(cleanMessage) : '';
        return this._show(message, type, {
            dismissMs: AUTO_DISMISS_MS,
            attentionAgentId: agentId,
            attentionExpectedMessages: agentId ? [cleanMessage] : [],
        });
    }

    showAttention(payload) {
        if (this._destroyed || !this.container) return;
        const agentId = attentionAgentId(payload);
        const observedName = this._agentLabels.get(agentId) || '';
        if (payload?.agent) this._rememberAgentLabel(payload.agent);
        const message = attentionNotice(payload, observedName);
        if (!message) return;
        const eventKey = `${agentId}:${cleanLabel(payload?.reason || payload?.status || payload?.label)}`;
        const existing = [...this.toasts]
            .reverse()
            .find(entry => entry.attentionAgentId === agentId && entry.attentionEventKey === eventKey);
        if (existing) {
            this._preferMessage(existing, message);
            return existing;
        }
        return this._show(message, 'warning', {
            dismissMs: PRIMARY_CUE_DISMISS_MS,
            cueKey: `attention:${eventKey}`,
            cueKind: 'attention',
            primary: true,
            attentionAgentId: agentId,
            attentionEventKey: eventKey,
            attentionExpectedMessages: [message],
        });
    }

    showDigest(payload) {
        if (this._destroyed || !this.container) return;

        const message = cleanDigestMessage(payload?.message);
        if (!message) return;

        const type = cleanLabel(payload?.type) || 'info';
        // One digest at a time: a newer summary supersedes an older one rather
        // than stacking two overlapping accounts of the same absence.
        const existing = this.toasts.find(entry => entry.cueKind === 'unattended-digest');
        if (existing) this._remove(existing);

        return this._show(message, type, {
            dismissMs: DIGEST_DISMISS_MS,
            cueKind: 'unattended-digest',
            primary: true,
        });
    }

    showCue(payload) {
        if (this._destroyed || !this.container) return;

        const kind = cleanLabel(payload?.kind) || 'unknown';
        const context = this._cueContextFor(kind);
        const contractedAgentId = payload?.agentId == null ? '' : cleanLabel(String(payload.agentId));
        const agentId = contractedAgentId || context?.agentId || '';
        const observedLabel = this._agentLabels.get(agentId) || context?.label;
        const message = formatCueCaption(payload, observedLabel);
        if (!message) return;

        // AttentionService's direct notice is more specific than the generic
        // summons caption. Reuse either an event-owned notice or a direct
        // notice that was already shown for the same agent.
        const attention = [...this.toasts]
            .reverse()
            .find(entry => entry.attentionAgentId === agentId && entry.attentionAt
                && Date.now() - entry.attentionAt <= ATTENTION_NOTICE_GRACE_MS);
        if (attention) return attention;

        const key = `${kind}:${agentId || message}`;
        const duplicate = this.toasts.find(entry => entry.cueKey === key);
        const isPrimary = PRIMARY_CUES.has(kind);
        const dismissMs = isPrimary ? PRIMARY_CUE_DISMISS_MS : ROUTINE_CUE_DISMISS_MS;

        if (duplicate) {
            duplicate.count += 1;
            duplicate.el.textContent = `${duplicate.message} ×${duplicate.count}`;
            duplicate.el.setAttribute('aria-label', `${duplicate.message}, repeated ${duplicate.count} times`);
            this._restartDismissTimer(duplicate, dismissMs);
            return duplicate;
        }

        const visibleCues = this.toasts.filter(entry => entry.cueKey);
        if (visibleCues.length >= MAX_CUE_CAPTIONS) {
            const routine = visibleCues.find(entry => !entry.primary);
            // Routine ambience yields first. An all-primary stack may briefly
            // exceed the soft cap so a needs-you or distress cue never vanishes.
            if (routine) this._remove(routine);
            else if (!isPrimary) return;
        }

        const type = CUE_PRESENTATION[kind]?.type
            || (kind === 'council' || kind === 'hourBell' ? 'warning' : 'info');
        return this._show(message, type, {
            dismissMs,
            cueKey: key,
            cueKind: kind,
            primary: isPrimary,
            agentId,
        });
    }

    _collapseDirectAttention(message, type) {
        if (!message || !isAttentionNotice(message) || (type !== 'warning' && type !== 'error')) return null;

        const exact = [...this.toasts]
            .reverse()
            .find(entry => entry.attentionExpectedMessages?.has?.(message));
        if (exact) {
            this._preferMessage(exact, message);
            return exact;
        }

        const agentId = this._agentIdForMessage(message);
        if (!agentId) return null;
        const existing = [...this.toasts]
            .reverse()
            .find(entry => (entry.cueKind === 'summons' || entry.attentionAgentId === agentId)
                && (entry.agentId === agentId || entry.attentionAgentId === agentId));
        if (!existing) return null;
        existing.attentionAgentId = agentId;
        existing.attentionAt = Date.now();
        existing.attentionExpectedMessages ||= new Set();
        existing.attentionExpectedMessages.add(message);
        this._preferMessage(existing, message);
        return existing;
    }

    _agentIdForMessage(message) {
        for (const [agentId, label] of this._agentLabels) {
            if (message.toLowerCase().startsWith(`${label.toLowerCase()} `)) return agentId;
        }
        return '';
    }

    _preferMessage(entry, message) {
        const next = cleanLabel(message);
        if (!entry || !next || entry.message === next) return;
        if (attentionMessageSpecificity(next) < attentionMessageSpecificity(entry.message)) return;
        entry.message = next;
        entry.el.textContent = next;
        entry.el.setAttribute('aria-label', next);
    }

    _show(message, type, {
        dismissMs,
        cueKey = '',
        cueKind = '',
        primary = false,
        agentId = '',
        attentionAgentId = '',
        attentionEventKey = '',
        attentionExpectedMessages = [],
    }) {
        if (!this._makeRoom(primary)) return;

        const el = this.documentRef?.createElement?.('div');
        if (!el) return;
        el.className = `toast toast--${type}`;
        el.textContent = message;
        if (type === 'error' || primary) el.setAttribute('role', 'alert');
        if (cueKind) {
            el.classList.add('toast--cue');
            el.dataset.cueKind = cueKind;
        }
        this.container.appendChild(el);

        const entry = {
            el,
            message,
            count: 1,
            cueKey,
            cueKind,
            primary,
            agentId,
            attentionAgentId,
            attentionEventKey,
            attentionAt: attentionAgentId || attentionEventKey ? Date.now() : 0,
            attentionExpectedMessages: new Set(attentionExpectedMessages),
            dismissTimer: null,
            removalTimer: null,
        };
        this.toasts.push(entry);
        this._restartDismissTimer(entry, dismissMs);
        return entry;
    }

    _makeRoom(incomingIsPrimary) {
        while (this.toasts.length >= MAX_TOASTS) {
            const routine = this.toasts.find(entry => !entry.primary);
            if (routine) this._remove(routine);
            else if (!incomingIsPrimary) return false;
            else break;
        }
        return true;
    }

    _restartDismissTimer(entry, dismissMs) {
        if (entry.dismissTimer) clearTimeout(entry.dismissTimer);
        entry.dismissTimer = setTimeout(() => {
            entry.dismissTimer = null;
            this._fadeOut(entry);
        }, dismissMs);
    }

    _rememberAgentLabel(agent) {
        const id = agent?.id == null ? '' : cleanLabel(String(agent.id));
        const label = cleanLabel(agent?.name || agent?.displayName || agent?.label);
        if (!id || !label) return;
        this._agentLabels.delete(id);
        this._agentLabels.set(id, label);
        while (this._agentLabels.size > 256) {
            this._agentLabels.delete(this._agentLabels.keys().next().value);
        }
    }

    _rememberCueContext(scene) {
        const kind = cleanLabel(scene?.kind);
        if (kind !== 'arrival' && kind !== 'departure') return;
        const agentId = scene?.agentId == null ? '' : cleanLabel(String(scene.agentId));
        const label = cleanLabel(scene?.label);
        if (!agentId && !label) return;
        this._recentCueContext.set(kind, { agentId, label, at: Date.now() });
    }

    _cueContextFor(kind) {
        const context = this._recentCueContext.get(kind);
        if (!context) return null;
        this._recentCueContext.delete(kind);
        return Date.now() - context.at <= CUE_CONTEXT_MAX_AGE_MS ? context : null;
    }

    _fadeOut(entry) {
        if (this._destroyed || entry.removalTimer || !this.toasts.includes(entry)) return;
        entry.el.classList.add('toast--fadeout');
        entry.removalTimer = setTimeout(() => {
            entry.removalTimer = null;
            this._remove(entry);
        }, 300);
    }

    _remove(entry) {
        if (!entry) return;
        if (entry.dismissTimer) clearTimeout(entry.dismissTimer);
        if (entry.removalTimer) clearTimeout(entry.removalTimer);
        entry.dismissTimer = null;
        entry.removalTimer = null;
        if (entry.el.parentNode) {
            entry.el.parentNode.removeChild(entry.el);
        }
        const idx = this.toasts.indexOf(entry);
        if (idx !== -1) this.toasts.splice(idx, 1);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const unsubscribe of this._eventUnsubscribes) unsubscribe();
        this._eventUnsubscribes = [];
        this._eventTarget = null;
        this._agentLabels.clear();
        this._recentCueContext.clear();
        for (const entry of [...this.toasts]) this._remove(entry);
        this.container = null;
        this.documentRef = null;
    }
}
