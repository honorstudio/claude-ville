import { eventBus } from '../../domain/events/DomainEvent.js';
import { worldToTile } from './Projection.js';

const ARRIVAL_WINDOW_MS = 8000;
const DEPARTURE_WINDOW_MS = 12000;
const MAX_RECENT_DEPARTURES = 6;
// 4.5 — a dense project's remaining shared files are named by building count,
// never by one thread per pair. Three buildings plus an exact remainder.
const OVERLAP_BUILDING_LIMIT = 3;

function pairKey(aId, bId) {
    return [aId, bId].sort().join('|');
}

function basenameOf(pathText) {
    const segments = String(pathText || '').split(/[\\/]+/).filter(Boolean);
    return segments.at(-1) || String(pathText || '');
}

// Which single peer edge a selected agent shows. Explicit operator intent wins
// (a hovered peer), then a drawable peer, then the loud kind, then established
// concurrency, then the most recent observation, then the path for stability.
function compareOverlapCandidates(a, b) {
    return (a.hoverRank - b.hoverRank)
        || (a.availableRank - b.availableRank)
        || (a.kindRank - b.kindRank)
        || (a.overlapRank - b.overlapRank)
        || ((b.at ?? 0) - (a.at ?? 0))
        || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export class RelationshipState {
    constructor(world) {
        this.world = world;
        this.parentToChildren = new Map();
        this.childToParent = new Map();
        this.teamToMembers = new Map();
        this.advisorPairs = [];
        this.recentArrivals = [];
        this.recentDepartures = [];
        this.chatPairs = [];
        // 4.5 — the shared-file overlap snapshot. Separately named: it is
        // observation evidence about files, not a family/team/advisor bond, and
        // it never stacks onto those rings.
        this.fileOverlap = null;
        this._lastSpriteTiles = new Map();
        this._membershipDirty = true;
        this._lastMembership = new Map();
        this._cachedSnapshotTeamToMembersArrays = new Map();
        this._snapshot = null;
        this._disposed = false;
        this.unsubscribers = [
            eventBus.on('agent:added', (agent) => {
                this.recentArrivals.push({ agentId: agent.id, at: performance.now() });
                this._membershipDirty = true;
            }),
            eventBus.on('agent:updated', (agent) => {
                if (!agent || !agent.id) { this._membershipDirty = true; return; }
                const prev = this._lastMembership.get(agent.id);
                const nextParent = agent.parentSessionId || null;
                const nextTeam = agent.teamName || null;
                if (!prev || prev.parentSessionId !== nextParent || prev.teamName !== nextTeam) {
                    this._membershipDirty = true;
                }
            }),
            eventBus.on('agent:removed', (agent) => {
                const lastTile = this._lastSpriteTiles.get(agent.id) || (
                    agent.position ? { tileX: agent.position.x, tileY: agent.position.y } : null
                );
                this.recentDepartures.push({
                    agentId: agent.id,
                    name: agent.name || agent.displayName || null,
                    provider: agent.provider || null,
                    parentSessionId: agent.parentSessionId || null,
                    teamName: agent.teamName || null,
                    lastTile,
                    at: performance.now(),
                });
                if (this.recentDepartures.length > MAX_RECENT_DEPARTURES) {
                    this.recentDepartures.splice(0, this.recentDepartures.length - MAX_RECENT_DEPARTURES);
                }
                this._lastSpriteTiles.delete(agent.id);
                this._membershipDirty = true;
            }),
        ];
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this.parentToChildren.clear();
        this.childToParent.clear();
        this.teamToMembers.clear();
        this.advisorPairs = [];
        this.recentArrivals = [];
        this.recentDepartures = [];
        this.chatPairs = [];
        this._lastSpriteTiles.clear();
        this._lastMembership.clear();
        this._cachedSnapshotTeamToMembersArrays.clear();
        this._snapshot = null;
        this.world = null;
    }

    update({ agentSprites = null, now = performance.now() } = {}) {
        if (this._disposed) return null;
        this.reconcile({ agentSprites, now });
        return this._snapshot;
    }

    reconcile({ agentSprites = null, now = performance.now() } = {}) {
        if (this._disposed) return this;
        this._prune(now);
        const sprites = agentSprites?.values ? Array.from(agentSprites.values()) : [];
        this._rememberSpriteTiles(sprites);
        if (this._membershipDirty) {
            this._rebuildMembership();
            this._membershipDirty = false;
        }
        this._rebuildChatPairs(sprites);
        this._rebuildFileOverlap(sprites);
        this._snapshot = {
            parentToChildren: this.parentToChildren,
            childToParent: this.childToParent,
            teamToMembers: this._cachedSnapshotTeamToMembersArrays,
            recentArrivals: this.recentArrivals.map(item => ({ ...item, sinceMs: now - item.at })),
            recentDepartures: this.recentDepartures.map(item => ({ ...item, sinceMs: now - item.at })),
            chatPairs: this.chatPairs.map(pair => ({ ...pair })),
            advisorPairs: this.advisorPairs.map(pair => ({ ...pair })),
            fileOverlap: this.fileOverlap,
        };
        return this;
    }

    getSnapshot() {
        if (this._disposed) return null;
        return this._snapshot || this.update();
    }

    getDiagnostics() {
        return {
            parents: this.parentToChildren.size,
            children: this.childToParent.size,
            teams: this.teamToMembers.size,
            recentArrivals: this.recentArrivals.length,
            recentDepartures: this.recentDepartures.length,
            chatPairs: this.chatPairs.length,
            advisorPairs: this.advisorPairs.length,
            overlapFiles: this.fileOverlap?.files || 0,
            overlapPeers: this.fileOverlap?.peers || 0,
            rememberedSpriteTiles: this._lastSpriteTiles.size,
            rememberedMemberships: this._lastMembership.size,
            disposed: this._disposed,
        };
    }

    _rebuildMembership() {
        this.parentToChildren.clear();
        this.childToParent.clear();
        this.teamToMembers.clear();
        this.advisorPairs = [];
        this._lastMembership.clear();
        this._cachedSnapshotTeamToMembersArrays.clear();
        for (const agent of this.world?.agents?.values?.() || []) {
            const parentSessionId = agent.parentSessionId || null;
            const teamName = agent.teamName || null;
            this._lastMembership.set(agent.id, { parentSessionId, teamName });
            if (parentSessionId) {
                this.childToParent.set(agent.id, parentSessionId);
                let bucket = this.parentToChildren.get(parentSessionId);
                if (!bucket) {
                    bucket = new Set();
                    this.parentToChildren.set(parentSessionId, bucket);
                }
                bucket.add(agent.id);
            }
            if (agent.isAdvisor) {
                this.advisorPairs.push({ advisorId: agent.id, parentId: parentSessionId });
            }
            if (teamName) {
                let members = this.teamToMembers.get(teamName);
                if (!members) {
                    members = new Set();
                    this.teamToMembers.set(teamName, members);
                }
                members.add(agent.id);
            }
        }

        for (const [team, members] of this.teamToMembers) {
            this._cachedSnapshotTeamToMembersArrays.set(team, [...members]);
        }
    }

    _rebuildChatPairs(sprites) {
        const seen = new Set();
        const out = [];
        for (const sprite of sprites) {
            const aId = sprite.agent?.id;
            const bId = sprite.chatPartner?.agent?.id;
            if (!aId || !bId || aId === bId) continue;
            const key = pairKey(aId, bId);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ aId, bId });
        }
        this.chatPairs = out;
    }

    /**
     * 4.5 — the shared-file overlap snapshot for the selected agent.
     *
     * Server-detected `agent.collisions` are exact canonical-path overlaps with
     * per-edge observation times. This picks *one* peer edge (a hovered peer
     * first, so the operator cycles edges by explicit selection/hover) and
     * reduces every remaining shared file to exact per-building counts, so a
     * hundred agents can never produce pairwise threads.
     */
    _rebuildFileOverlap(sprites) {
        let selected = null;
        let hoveredId = '';
        for (const sprite of sprites) {
            const id = sprite.agent?.id ? String(sprite.agent.id) : '';
            if (!id) continue;
            if (sprite.selected) selected = sprite;
            else if (sprite.hovered) hoveredId = id;
        }
        const collisions = Array.isArray(selected?.agent?.collisions) ? selected.agent.collisions : [];
        if (!selected || !collisions.length) {
            this.fileOverlap = null;
            return;
        }

        const selectedId = String(selected.agent.id);
        const drawable = new Set();
        for (const sprite of sprites) {
            const id = sprite.agent?.id ? String(sprite.agent.id) : '';
            if (id && !sprite.isArrivalPending?.()) drawable.add(id);
        }

        const paths = new Set();
        const peers = new Set();
        const candidates = [];
        for (const collision of collisions) {
            const path = typeof collision?.path === 'string' ? collision.path.trim() : '';
            if (!path || !Array.isArray(collision.agents)) continue;
            const observations = Array.isArray(collision.observations) ? collision.observations : [];
            const writers = observations.length
                ? observations.filter(entry => entry?.op === 'write').length
                : null;
            const readers = observations.length
                ? observations.filter(entry => entry?.op === 'read').length
                : null;
            paths.add(path);
            for (const rawId of collision.agents) {
                const peerId = String(rawId ?? '');
                if (!peerId || peerId === selectedId) continue;
                peers.add(peerId);
                const observation = observations.find(entry => String(entry?.agentId ?? '') === peerId) || null;
                const at = Number.isFinite(observation?.at) ? observation.at : null;
                const available = drawable.has(peerId);
                candidates.push({
                    peerId,
                    path,
                    kind: collision.kind === 'write-write' ? 'write-write' : 'read-write',
                    overlapKind: collision.overlapKind === 'concurrent' ? 'concurrent' : 'recent',
                    writers,
                    readers,
                    participants: collision.agents.length,
                    peerOp: observation?.op === 'write' || observation?.op === 'read' ? observation.op : null,
                    at,
                    available,
                    hoverRank: peerId === hoveredId ? 0 : 1,
                    availableRank: available ? 0 : 1,
                    kindRank: collision.kind === 'write-write' ? 0 : 1,
                    overlapRank: collision.overlapKind === 'concurrent' ? 0 : 1,
                });
            }
        }
        if (!candidates.length) {
            this.fileOverlap = null;
            return;
        }

        candidates.sort(compareOverlapCandidates);
        const edge = candidates[0];
        const agents = this.world?.agents;

        // Remaining files: one exact count per building where a peer is working.
        const filesByBuilding = new Map();
        const placed = new Set();
        for (const candidate of candidates) {
            if (candidate.path === edge.path) continue;
            const peer = agents?.get?.(candidate.peerId) || null;
            const building = peer?.targetBuildingType || peer?.lastKnownBuildingType || null;
            if (!building) continue;
            let bucket = filesByBuilding.get(building);
            if (!bucket) { bucket = new Set(); filesByBuilding.set(building, bucket); }
            bucket.add(candidate.path);
            placed.add(candidate.path);
        }
        const aggregates = [...filesByBuilding.entries()]
            .map(([building, bucket]) => ({ building, files: bucket.size }))
            .sort((a, b) => (b.files - a.files) || (a.building < b.building ? -1 : a.building > b.building ? 1 : 0));
        const shown = aggregates.slice(0, OVERLAP_BUILDING_LIMIT);
        const remainder = aggregates.slice(OVERLAP_BUILDING_LIMIT)
            .reduce((total, entry) => total + entry.files, 0);
        const unplaced = [...paths].filter(path => path !== edge.path && !placed.has(path)).length;

        this.fileOverlap = {
            selectedId,
            edge: {
                peerId: edge.peerId,
                peerName: agents?.get?.(edge.peerId)?.name || edge.peerId,
                path: edge.path,
                basename: basenameOf(edge.path),
                kind: edge.kind,
                overlapKind: edge.overlapKind,
                writers: edge.writers,
                readers: edge.readers,
                participants: edge.participants,
                peerOp: edge.peerOp,
                observedAt: edge.at,
                available: edge.available,
            },
            files: paths.size,
            peers: peers.size,
            aggregates: shown,
            otherFiles: remainder + unplaced,
        };
    }

    _rememberSpriteTiles(sprites) {
        for (const sprite of sprites) {
            const id = sprite.agent?.id;
            if (!id) continue;
            this._lastSpriteTiles.set(id, this._screenToTile(sprite.x, sprite.y));
        }
    }

    _screenToTile(x, y) {
        return worldToTile(x, y);
    }

    _prune(now) {
        this.recentArrivals = this.recentArrivals.filter(item => now - item.at <= ARRIVAL_WINDOW_MS);
        this.recentDepartures = this.recentDepartures.filter(item => now - item.at <= DEPARTURE_WINDOW_MS);
    }
}
