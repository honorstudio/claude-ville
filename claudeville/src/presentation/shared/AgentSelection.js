import { eventBus } from '../../domain/events/DomainEvent.js';

export const AGENT_SELECTED_EVENT = 'agent:selected';
export const AGENT_DESELECTED_EVENT = 'agent:deselected';

export function emitAgentSelected(agent) {
    if (agent) eventBus.emit(AGENT_SELECTED_EVENT, agent);
}

export function emitAgentDeselected() {
    eventBus.emit(AGENT_DESELECTED_EVENT);
}

export function toggleAgentSelection(world, agentId, selectedId) {
    if (!agentId) return;
    if (agentId === selectedId) {
        emitAgentDeselected();
        return;
    }
    const agent = world?.agents?.get?.(agentId);
    emitAgentSelected(agent);
}

// #31 Selection echo: a single global mirror that paints "the one you're
// watching" across every surface. On selection it sets `--cv-selected-accent`
// on <body> and toggles a `--selected` marker on the matching dashboard card
// and sidebar row (queried live from the DOM), so World, Dashboard and Sidebar
// all share one accent halo. CSS owns the visual treatment + reduced-motion.
const SELECTED_ACCENT = '#ffe58d'; // matches --cv-gold-bright

function _markSelectedElements(nextId, previousId) {
    if (typeof document === 'undefined') return;
    const clear = (id) => {
        if (!id) return;
        const sel = `[data-agent-id="${(window.CSS?.escape || String)(id)}"]`;
        document.querySelectorAll(sel).forEach((el) => {
            el.classList.remove('dash-card--selected', 'sidebar__agent--selected');
        });
    };
    clear(previousId);
    if (!nextId) {
        document.body?.style.removeProperty('--cv-selected-accent');
        document.body?.removeAttribute('data-cv-selected');
        return;
    }
    document.body?.style.setProperty('--cv-selected-accent', SELECTED_ACCENT);
    document.body?.setAttribute('data-cv-selected', '');
    const sel = `[data-agent-id="${(window.CSS?.escape || String)(nextId)}"]`;
    document.querySelectorAll(sel).forEach((el) => {
        if (el.classList.contains('dash-card')) el.classList.add('dash-card--selected');
        if (el.classList.contains('sidebar__agent')) el.classList.add('sidebar__agent--selected');
    });
}

let _echoInstalled = false;
let _echoCurrent = null;
export function installSelectionEcho() {
    if (_echoInstalled || typeof document === 'undefined') return;
    _echoInstalled = true;
    eventBus.on(AGENT_SELECTED_EVENT, (agent) => {
        const next = agent?.id || null;
        if (next === _echoCurrent) return;
        _markSelectedElements(next, _echoCurrent);
        _echoCurrent = next;
    });
    eventBus.on(AGENT_DESELECTED_EVENT, () => {
        if (_echoCurrent === null) return;
        _markSelectedElements(null, _echoCurrent);
        _echoCurrent = null;
    });
}

export function resetAgentSelection() {
    _markSelectedElements(null, _echoCurrent);
    _echoCurrent = null;
}

// Self-install on import; harmless under SSR/tests via the document guard.
installSelectionEcho();

export class AgentSelectionMirror {
    constructor({ onChange, notifyOnRepeat = false } = {}) {
        this.selectedId = null;
        this._onChange = onChange;
        this._notifyOnRepeat = notifyOnRepeat;
        this._unsubscribers = [
            eventBus.on(AGENT_SELECTED_EVENT, (agent) => {
                this._setSelectedId(agent?.id || null, { force: this._notifyOnRepeat });
            }),
            eventBus.on(AGENT_DESELECTED_EVENT, () => {
                this._setSelectedId(null);
            }),
        ];
    }

    isSelected(agentId) {
        return Boolean(agentId && agentId === this.selectedId);
    }

    destroy() {
        for (const unsubscribe of this._unsubscribers.splice(0)) {
            unsubscribe?.();
        }
        this._onChange = null;
        this._notifyOnRepeat = false;
    }

    _setSelectedId(nextId, { force = false } = {}) {
        const previousId = this.selectedId;
        this.selectedId = nextId;
        if (force || previousId !== nextId) {
            this._onChange?.(nextId, previousId);
        }
    }
}
