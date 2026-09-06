// Singleton event bus (observer pattern)
//
// Event-name contracts (string keys; no registry enforcement):
//   agent:added, agent:updated, agent:removed
//   agent:selected, agent:deselected
//   agents:pins-changed                       // { pinnedAgentIds: string[] } in insertion order
//   building:selected, building:deselected     // emitted by IsometricRenderer click handler
//   building:active-agents                      // map<type,{count,recencyScore,tier}> from LandmarkActivity (~500ms)
//   tool:invoked, subagent:dispatched, subagent:completed
//   mode:changed, usage:updated
//   fps:updated                                 // number (~2/s) from IsometricRenderer loop, null when loop stops
//   atmosphere:updated                           // atmosphere snapshot (~2/s) from IsometricRenderer; audio director listens
//   weather:storm-flash                          // {intensity} per lightning strike from WeatherRenderer; audio thunder listens
//   ws:connected, ws:disconnected, ws:init, ws:update, ws:message
export const BUILDING_EVENTS = Object.freeze({
    SELECTED: 'building:selected',
    DESELECTED: 'building:deselected',
    ACTIVE_AGENTS: 'building:active-agents',
});

class DomainEvent {
    constructor() {
        this.listeners = new Map();
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);
        return () => this.off(event, callback);
    }

    off(event, callback) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                this.listeners.delete(event);
            }
        }
    }

    emit(event, data) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            for (const callback of callbacks) {
                try {
                    callback(data);
                } catch (error) {
                    const message = error?.message || String(error);
                    console.error(`[DomainEvent] listener failed for "${event}": ${message}`);
                }
            }
        }
    }
}

export const eventBus = new DomainEvent();
