import { eventBus } from '../domain/events/DomainEvent.js';
import { REFRESH_INTERVAL } from '../config/constants.js';

const POLL_TIMEOUT_MS = Math.max(5000, REFRESH_INTERVAL * 2);

export class SessionWatcher {
    constructor(agentManager, wsClient, dataSource) {
        this.agentManager = agentManager;
        this.wsClient = wsClient;
        this.dataSource = dataSource;
        this.pollTimer = null;
        this.running = false;
        this._pollController = null;
        this._pollPromise = null;
        this._pollGeneration = 0;

        this._onWsInit = (data) => this.agentManager.handleWebSocketMessage(data);
        this._onWsUpdate = (data) => this.agentManager.handleWebSocketMessage(data);
        this._onWsDisconnected = () => this._startPolling('socket-disconnected');
        this._onWsConnected = () => this._stopPolling('websocket-active');
    }

    start() {
        if (this.running) return;
        this.running = true;

        // Subscribe to WebSocket events
        eventBus.on('ws:init', this._onWsInit);
        eventBus.on('ws:update', this._onWsUpdate);
        eventBus.on('ws:disconnected', this._onWsDisconnected);
        eventBus.on('ws:connected', this._onWsConnected);

        // Connect WebSocket
        this.wsClient.connect();

        // Start fallback polling too (until the WebSocket connects)
        if (!this.wsClient.isConnected) {
            this._startPolling('websocket-unavailable');
        }
    }

    stop() {
        this.running = false;
        this._stopPolling('watcher-stopped');

        eventBus.off('ws:init', this._onWsInit);
        eventBus.off('ws:update', this._onWsUpdate);
        eventBus.off('ws:disconnected', this._onWsDisconnected);
        eventBus.off('ws:connected', this._onWsConnected);

        this.wsClient.disconnect();
    }

    _startPolling(reason = 'websocket-unavailable') {
        if (this.pollTimer || !this.running) return;
        this._pollGeneration++;
        console.log('[SessionWatcher] Started fallback polling');
        eventBus.emit('watcher:state', { state: 'polling', reason });
        void this._poll();
        this.pollTimer = setInterval(() => void this._poll(), REFRESH_INTERVAL);
    }

    _stopPolling(reason = 'websocket-active') {
        this._pollGeneration++;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            console.log('[SessionWatcher] Stopped polling (WebSocket active)');
            eventBus.emit('watcher:state', { state: 'idle', reason });
        }
        this._pollController?.abort?.('poll-stopped');
        this._pollController = null;
    }

    _poll() {
        if (!this.running || this._pollPromise) return this._pollPromise;
        const generation = this._pollGeneration;
        const controller = new AbortController();
        this._pollController = controller;
        const timeout = setTimeout(() => controller.abort('poll-timeout'), POLL_TIMEOUT_MS);
        const pollPromise = this._runPoll(generation, controller.signal)
            .finally(() => {
                clearTimeout(timeout);
                if (this._pollController === controller) this._pollController = null;
                if (this._pollPromise === pollPromise) this._pollPromise = null;
            });
        this._pollPromise = pollPromise;
        return pollPromise;
    }

    async _runPoll(generation, signal) {
        try {
            const [sessionsResult, usageResult] = await Promise.allSettled([
                this.dataSource.getSessions({ signal }),
                this.dataSource.getUsage({ signal }),
            ]);
            if (!this.running || generation !== this._pollGeneration) return;
            if (signal.aborted) {
                if (signal.reason === 'poll-timeout') {
                    eventBus.emit('watcher:state', { ok: false, code: 'poll-timeout' });
                }
                return;
            }
            if (sessionsResult.status === 'fulfilled') {
                const sessions = sessionsResult.value;
                if (sessions) {
                    this.agentManager.handleWebSocketMessage({ sessions });
                }
                eventBus.emit('watcher:state', { ok: true, at: Date.now() });
            } else {
                console.error('[SessionWatcher] Polling sessions failed:', sessionsResult.reason?.message || sessionsResult.reason);
                eventBus.emit('watcher:state', { ok: false, code: 'session-poll-failed' });
            }

            if (usageResult.status === 'fulfilled') {
                const usage = usageResult.value;
                if (usage) eventBus.emit('usage:updated', usage);
            } else {
                console.error('[SessionWatcher] Polling usage failed:', usageResult.reason?.message || usageResult.reason);
            }
        } catch (err) {
            if (signal.aborted || generation !== this._pollGeneration || !this.running) return;
            console.error('[SessionWatcher] Polling failed:', err.message);
            eventBus.emit('watcher:state', { ok: false, code: 'poll-failed' });
        }
    }
}
