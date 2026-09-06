import { eventBus } from '../domain/events/DomainEvent.js';
import { i18n } from '../config/i18n.js';

export class NotificationService {
    constructor(toast) {
        this.toast = toast;
        this.knownAgents = new Set();
        this.wsEverConnected = false;

        this._onAgentAdded = (agent) => {
            if (this.knownAgents.size > 0) {
                const msg = i18n.t('agentJoined');
                this.toast.show(typeof msg === 'function' ? msg(agent.name) : msg, 'info');
            }
            this.knownAgents.add(agent.id);
        };

        this._onAgentRemoved = (agent) => {
            const msg = i18n.t('agentLeft');
            this.toast.show(typeof msg === 'function' ? msg(agent.name) : msg, 'warning');
            this.knownAgents.delete(agent.id);
        };

        this._onWsConnected = () => {
            // Suppress the toast on the first connection of the page load; only
            // announce genuine reconnections (mirrors _onAgentAdded).
            if (this.wsEverConnected) {
                this.toast.show(i18n.t('serverConnected'), 'success');
            }
            this.wsEverConnected = true;
        };

        this._onWsDisconnected = () => {
            if (this.wsEverConnected) {
                this.toast.show(i18n.t('serverDisconnected'), 'error');
            }
        };

        this._onModeChanged = (mode) => {
            const key = mode === 'character' ? 'modeSwitchWorld' : 'modeSwitchDashboard';
            this.toast.show(i18n.t(key), 'info');
        };

        eventBus.on('agent:added', this._onAgentAdded);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on('ws:connected', this._onWsConnected);
        eventBus.on('ws:disconnected', this._onWsDisconnected);
        eventBus.on('mode:changed', this._onModeChanged);
    }

    destroy() {
        eventBus.off('agent:added', this._onAgentAdded);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off('ws:connected', this._onWsConnected);
        eventBus.off('ws:disconnected', this._onWsDisconnected);
        eventBus.off('mode:changed', this._onModeChanged);
    }
}
