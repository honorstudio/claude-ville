import { eventBus } from '../domain/events/DomainEvent.js';
import { WS_RECONNECT_INTERVAL } from '../config/constants.js';
import { LinkState } from '../application/VillageState.js';

function unescapeJsonPointerToken(token) {
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function cloneContainer(value) {
    return Array.isArray(value) ? value.slice() : { ...value };
}
const SESSION_EXECUTION_FIELDS = Object.freeze([
    'parentSessionId',
    'agentType',
    'subagentKind',
    'taskProgress',
    'tasks',
    'todos',
]);

function cloneSessionPayload(session) {
    if (!session || typeof session !== 'object') return session;
    const next = { ...session };
    for (const field of SESSION_EXECUTION_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(session, field)) continue;
        if (field === 'taskProgress') {
            const progress = session.taskProgress;
            next.taskProgress = progress && typeof progress === 'object'
                ? {
                    done: progress.done,
                    total: progress.total,
                    source: progress.source,
                }
                : progress;
        } else if (field === 'tasks') {
            next.tasks = Array.isArray(session.tasks)
                ? session.tasks.slice(0, 12).flatMap(task => {
                    const subject = typeof task?.subject === 'string'
                        ? task.subject.trim().slice(0, 120)
                        : '';
                    const status = typeof task?.status === 'string'
                        ? task.status.trim().slice(0, 64)
                        : '';
                    return subject && status ? [{ subject, status }] : [];
                })
                : session.tasks;
        } else if (field === 'todos') {
            next.todos = Array.isArray(session.todos)
                ? session.todos.slice(0, 64).map(todo => (
                    todo && typeof todo === 'object' ? { ...todo } : todo
                ))
                : session.todos;
        } else {
            next[field] = session[field];
        }
    }
    return next;
}

function cloneSessionPayloads(sessions) {
    return Array.isArray(sessions) ? sessions.map(cloneSessionPayload) : [];
}


function resolveArrayIndex(array, token, allowAppend) {
    if (token === '-' && allowAppend) return array.length;
    if (!/^\d+$/.test(token)) throw new Error(`Invalid array index: ${token}`);
    const index = Number(token);
    if (index > (allowAppend ? array.length : array.length - 1)) {
        throw new Error(`Array index out of bounds: ${token}`);
    }
    return index;
}

// Applies one JSON-Patch op (add/replace/remove) with path copying: every
// container along the op path is shallow-cloned, so consumers holding
// references into previously emitted payloads never see in-place mutation.
function applyJsonPatchOp(root, op) {
    if (!op || typeof op.path !== 'string' || op.path[0] !== '/') {
        throw new Error('Invalid patch op');
    }
    const tokens = op.path.split('/').slice(1).map(unescapeJsonPointerToken);
    const newRoot = cloneContainer(root);
    let parent = newRoot;
    for (let i = 0; i < tokens.length - 1; i++) {
        const key = Array.isArray(parent)
            ? resolveArrayIndex(parent, tokens[i], false)
            : tokens[i];
        const child = parent[key];
        if (child === null || typeof child !== 'object') {
            throw new Error(`Missing patch target: ${op.path}`);
        }
        const cloned = cloneContainer(child);
        parent[key] = cloned;
        parent = cloned;
    }
    const last = tokens[tokens.length - 1];
    if (Array.isArray(parent)) {
        if (op.op === 'add') parent.splice(resolveArrayIndex(parent, last, true), 0, op.value);
        else if (op.op === 'replace') parent[resolveArrayIndex(parent, last, false)] = op.value;
        else if (op.op === 'remove') parent.splice(resolveArrayIndex(parent, last, false), 1);
        else throw new Error(`Unsupported patch op: ${op.op}`);
    } else if (op.op === 'add' || op.op === 'replace') {
        parent[last] = op.value;
    } else if (op.op === 'remove') {
        delete parent[last];
    } else {
        throw new Error(`Unsupported patch op: ${op.op}`);
    }
    return newRoot;
}

function applyJsonPatch(state, patch) {
    if (!Array.isArray(patch)) throw new Error('Patch must be an array');
    let root = state;
    for (const op of patch) {
        root = applyJsonPatchOp(root, op);
    }
    return root;
}

export class WebSocketClient {
    constructor(options = {}) {
        const { performanceMetrics = null } = options || {};
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.performanceMetrics = performanceMetrics;
        this.state = Object.freeze({
            state: LinkState.SYNCING,
            attempts: 0,
            nextRetryAt: null,
            lastMessageAt: null,
            lastSnapshotAt: null,
            lastErrorCode: null,
        });
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.url = `${protocol}//${window.location.host}/ws`;
        // Delta protocol state: last full {sessions, collisions, teams, usage}
        // snapshot
        // and its server sequence number. Old servers never send deltas, so
        // these simply stay unused against a full-payload-only server.
        this._state = null;
        this._seq = null;
        this._resyncRequested = false;
    }

    get isConnected() {
        return this.connected;
    }

    connect() {
        if (this.ws && (
            this.ws.readyState === WebSocket.CONNECTING
            || this.ws.readyState === WebSocket.OPEN
        )) return;

        try {
            const socket = new WebSocket(this.url);
            this.ws = socket;

            socket.onopen = () => {
                if (this.ws !== socket) return;
                this.connected = true;
                this._resyncRequested = false;
                console.log('[WS] Connected');
                // Announce delta support; old servers ignore unknown types.
                this.send({ type: 'hello', deltas: true });
                eventBus.emit('ws:connected');
                this._clearReconnect();
                this._publishState({
                    state: this.reconnectAttempts > 0 ? LinkState.RECONNECTING : LinkState.SYNCING,
                    nextRetryAt: null,
                });
            };

            socket.onmessage = (event) => {
                if (this.ws !== socket) return;
                const metrics = this.performanceMetrics;
                const messagePerf = metrics && metrics.enabled !== false
                    ? metrics.beginMessage?.() || null
                    : null;
                try {
                    const data = JSON.parse(event.data);
                    this._publishState({ lastMessageAt: Date.now() });
                    this._handleMessage(data, messagePerf);
                } catch (err) {
                    if (messagePerf) metrics.cancelMessage?.(messagePerf);
                    console.error('[WS] Failed to parse message:', err.message);
                    this._publishState({ lastErrorCode: 'message-invalid' });
                }
            };

            socket.onclose = () => {
                if (this.ws !== socket) return;
                this.ws = null;
                this.connected = false;
                this._clearProtocolState();
                console.log('[WS] Disconnected');
                eventBus.emit('ws:disconnected');
                this._scheduleReconnect('socket-closed');
            };

            socket.onerror = () => {
                if (this.ws !== socket) return;
                console.error('[WS] Error occurred');
                this.connected = false;
                this._publishState({
                    lastErrorCode: this.state.lastSnapshotAt === null
                        ? 'initial-sync-failed'
                        : 'socket-error',
                });
            };
        } catch (err) {
            console.error('[WS] Connection failed:', err.message);
            this._scheduleReconnect('initial-sync-failed');
        }
    }

    disconnect() {
        this._clearReconnect();
        const socket = this.ws;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            this.ws = null;
            if (
                socket.readyState === WebSocket.CONNECTING
                || socket.readyState === WebSocket.OPEN
            ) {
                socket.close();
            }
        }
        this.connected = false;
        this._clearProtocolState();
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    _handleMessage(data, messagePerf = null) {
        switch (data.type) {
            case 'init':
                if (messagePerf) this.performanceMetrics.cancelMessage?.(messagePerf);
                // Reset reconnect attempts only after server confirms a healthy session,
                // so half-open TCPs that never deliver init keep backing off.
                this.reconnectAttempts = 0;
                this._rememberSnapshot(data);
                this._publishSnapshot();
                eventBus.emit('ws:init', data);
                if (data.usage) eventBus.emit('usage:updated', data.usage);
                break;
            case 'update':
                if (messagePerf) this.performanceMetrics.cancelMessage?.(messagePerf);
                this._rememberSnapshot(data);
                this.reconnectAttempts = 0;
                this._publishSnapshot();
                eventBus.emit('ws:update', data);
                if (data.usage) eventBus.emit('usage:updated', data.usage);
                break;
            case 'update-delta':
                this._handleDelta(data, messagePerf);
                break;
            case 'pong':
                if (messagePerf) this.performanceMetrics.cancelMessage?.(messagePerf);
                break;
            default:
                if (messagePerf) this.performanceMetrics.cancelMessage?.(messagePerf);
                eventBus.emit('ws:message', data);
        }
    }

    _rememberSnapshot(data) {
        this._state = {
            sessions: cloneSessionPayloads(data.sessions),
            gitEventFields: Array.isArray(data.gitEventFields) ? data.gitEventFields : [],
            gitEventStringTables: Array.isArray(data.gitEventStringTables)
                ? data.gitEventStringTables
                : [],
            gitEventsById: data.gitEventsById && typeof data.gitEventsById === 'object'
                ? data.gitEventsById
                : {},
            collisions: Array.isArray(data.collisions) ? data.collisions : [],
            teams: Array.isArray(data.teams) ? data.teams : [],
            usage: data.usage ?? null,
        };
        this._seq = Number.isFinite(data.seq) ? data.seq : null;
        this._resyncRequested = false;
    }

    _clearProtocolState() {
        this._state = null;
        this._seq = null;
        this._resyncRequested = false;
    }

    getDebugSnapshot() {
        const sessions = this._state?.sessions || [];
        const teams = this._state?.teams || [];
        let retainedBytes = 0;
        if (this._state) {
            try { retainedBytes = JSON.stringify(this._state).length * 2; } catch { /* diagnostic only */ }
        }
        return {
            connected: this.connected,
            retainedSessions: sessions.length,
            retainedTeams: teams.length,
            retainedBytes,
            sequence: this._seq,
        };
    }

    _handleDelta(data, messagePerf = null) {
        const metrics = this.performanceMetrics;
        const deltaPerf = metrics && metrics.enabled !== false
            ? metrics.beginDelta?.(messagePerf) || null
            : null;
        if (!this._state || this._seq === null || data.baseSeq !== this._seq) {
            if (deltaPerf) metrics.discardDelta?.(deltaPerf, 'resync');
            this._publishState({ lastErrorCode: 'delta-baseline-mismatch' });
            this._requestResync();
            return;
        }
        let next;
        if (deltaPerf) metrics.markPatchStart?.(deltaPerf);
        try {
            next = applyJsonPatch(this._state, data.patch);
        } catch (err) {
            if (deltaPerf) metrics.discardDelta?.(deltaPerf, 'resync');
            console.warn('[WS] Failed to apply delta, requesting resync:', err.message);
            this._publishState({ lastErrorCode: 'patch-failed' });
            this._requestResync();
            return;
        }
        if (deltaPerf) metrics.markPatchApplied?.(deltaPerf, data.patch.length);
        next = { ...next, sessions: cloneSessionPayloads(next.sessions) };
        this._state = next;
        this._seq = data.seq;
        this.reconnectAttempts = 0;
        this._publishSnapshot();
        const payload = {
            type: 'update',
            sessions: next.sessions,
            gitEventFields: next.gitEventFields,
            gitEventStringTables: next.gitEventStringTables,
            gitEventsById: next.gitEventsById,
            collisions: next.collisions,
            teams: next.teams,
            usage: next.usage,
            timestamp: data.timestamp,
        };
        if (deltaPerf) metrics.markFanoutStart?.(deltaPerf);
        eventBus.emit('ws:update', payload);
        if (payload.usage) eventBus.emit('usage:updated', payload.usage);
        if (deltaPerf) {
            metrics.markFanoutEnd?.(deltaPerf);
            metrics.finishDelta?.(deltaPerf);
        }
    }

    _requestResync() {
        // One outstanding resync at a time; the flag clears when the next
        // full snapshot (init/update) arrives or the socket reopens.
        if (this._resyncRequested) return;
        this._resyncRequested = true;
        this.send({ type: 'resync' });
    }

    _scheduleReconnect(errorCode = 'socket-closed') {
        this._clearReconnect();
        this.reconnectAttempts++;
        const backoff = Math.min(
            WS_RECONNECT_INTERVAL * Math.pow(2, this.reconnectAttempts - 1),
            15000
        );
        // Jitter avoids lockstep reconnect storms when many tabs reopen at once.
        const delay = backoff + Math.random() * 500;
        const nextRetryAt = Date.now() + delay;
        this._publishState({
            state: LinkState.RECONNECTING,
            attempts: this.reconnectAttempts,
            nextRetryAt,
            lastErrorCode: errorCode,
        });
        this.reconnectTimer = setTimeout(() => {
            if (this.reconnectAttempts > 3) {
                console.log(`[WS] Reconnect attempt... (retrying in ${Math.round(delay / 1000)} seconds)`);
            }
            this.connect();
        }, delay);
    }

    _clearReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    _publishSnapshot() {
        this._publishState({
            state: LinkState.LIVE,
            attempts: 0,
            nextRetryAt: null,
            lastSnapshotAt: Date.now(),
            lastErrorCode: null,
        });
    }

    _publishState(updates = {}) {
        const next = {
            state: updates.state ?? this.state.state,
            attempts: updates.attempts ?? this.reconnectAttempts,
            nextRetryAt: updates.nextRetryAt !== undefined
                ? updates.nextRetryAt
                : this.state.nextRetryAt,
            lastMessageAt: updates.lastMessageAt !== undefined
                ? updates.lastMessageAt
                : this.state.lastMessageAt,
            lastSnapshotAt: updates.lastSnapshotAt !== undefined
                ? updates.lastSnapshotAt
                : this.state.lastSnapshotAt,
            lastErrorCode: updates.lastErrorCode !== undefined
                ? updates.lastErrorCode
                : this.state.lastErrorCode,
        };
        this.state = Object.freeze(next);
        eventBus.emit('ws:state', next);
    }
}
