import { MAP_SIZE } from '../../config/constants.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const TILE_WEIGHTS = Object.freeze({
    bridge: 0.55,
    dock: 0.62,
    plaza: 0.68,
    road: 0.65,
    lane: 0.58,
    avoid: 1.35,
    congestionStep: 0.16,
    congestionMax: 1.2,
});

export class Pathfinder {
    constructor(grid) {
        this.grid = grid;
        this.walkableTiles = this._buildWalkableList(grid);
        this._pathCache = new Map();
        this._cacheHits = 0;
        this._cacheMisses = 0;
    }

    _buildWalkableList(grid) {
        const tiles = [];
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                if (grid[y * MAP_SIZE + x] === 1) tiles.push({ tileX: x, tileY: y });
            }
        }
        return tiles;
    }

    sampleWalkable(rng) {
        return this.walkableTiles[Math.min(this.walkableTiles.length - 1, Math.floor(rng * this.walkableTiles.length))];
    }

    nearestWalkable(tileX, tileY, maxRadius = 8) {
        const originX = Math.round(tileX);
        const originY = Math.round(tileY);
        if (this.isWalkable(originX, originY)) return { tileX: originX, tileY: originY };

        let best = null;
        let bestDistance = Infinity;
        const radiusLimit = Math.max(1, Math.floor(maxRadius));
        for (let radius = 1; radius <= radiusLimit; radius++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                    const nx = originX + dx;
                    const ny = originY + dy;
                    if (!this.isWalkable(nx, ny)) continue;
                    const distance = dx * dx + dy * dy;
                    if (distance < bestDistance) {
                        best = { tileX: nx, tileY: ny };
                        bestDistance = distance;
                    }
                }
            }
            if (best) return best;
        }

        return null;
    }

    _cacheResult(key, value) {
        if (this._pathCache.size >= 256) {
            this._pathCache.delete(this._pathCache.keys().next().value);
        }
        // The cache owns both the array and its waypoint objects. AgentSprite
        // may stitch or trim the returned route, so sharing either would let a
        // caller corrupt every later lookup for the same endpoints.
        this._pathCache.set(key, this._copyPath(value));
    }

    _copyPath(path) {
        return Array.isArray(path)
            ? path.map(tile => ({ tileX: tile.tileX, tileY: tile.tileY }))
            : [];
    }

    getDiagnostics() {
        return {
            cacheEntries: this._pathCache.size,
            cacheLimit: 256,
            cacheHits: this._cacheHits,
            cacheMisses: this._cacheMisses,
        };
    }

    setGrid(grid) {
        this.grid = grid;
        this.walkableTiles = this._buildWalkableList(grid);
        this._pathCache.clear();
        this._cacheHits = 0;
        this._cacheMisses = 0;
    }

    isWalkable(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return false;
        return this.grid[tileY * MAP_SIZE + tileX] === 1;
    }

    // Returns an array of {tileX, tileY} waypoints from `from` exclusive to `to` inclusive.
    // Empty array if unreachable. If straight-line works (no obstacles between centers
    // sampled at tile granularity), returns the single waypoint [to].
    findPath(from, to, bridgeTiles, options = null) {
        const fx = Math.round(from.tileX);
        const fy = Math.round(from.tileY);
        const pathOptions = this._normalizePathOptions(options, bridgeTiles);

        // Guard: if the start tile is unwalkable (e.g., agent currently
        // straddling a shore tile due to floating-point drift), search the
        // 8 cardinal and diagonal neighbors for a walkable foothold and recurse from
        // there. Prevents agents from getting permanently stuck.
        if (!this.isWalkable(fx, fy)) {
            const nearest = this.nearestWalkable(fx, fy, 8);
            if (nearest) {
                const sub = this.findPath(nearest, to, bridgeTiles, options);
                if (sub.length > 0) return [nearest, ...sub];
            }
            console.warn('[Pathfinder] stuck: no walkable tile near', fx, fy);
            return [];
        }

        const targetCandidates = this._walkableCandidates(Math.round(to.tileX), Math.round(to.tileY));
        if (targetCandidates.length === 0) return [];

        const cacheKey = `${fx},${fy}|${Math.round(to.tileX)},${Math.round(to.tileY)}${this._pathOptionsCacheKey(pathOptions)}`;
        const cached = this._pathCache.get(cacheKey);
        if (cached) {
            this._cacheHits++;
            return this._copyPath(cached);
        }
        this._cacheMisses++;

        if (pathOptions.weighted) {
            const weightedResult = this._findWeightedPath(fx, fy, targetCandidates, bridgeTiles, pathOptions);
            if (weightedResult.length > 0) {
                this._cacheResult(cacheKey, weightedResult);
                return weightedResult;
            }
        }

        // Fast path: if a tile-step line from `from` to `to` never crosses a blocked tile,
        // skip BFS entirely.
        for (const target of targetCandidates) {
            const lineTiles = this._lineWalkableTiles(fx, fy, target.tileX, target.tileY);
            if (lineTiles) {
                const fastTiles = lineTiles.slice(1);
                const crossesBridge = fastTiles.some((t) => bridgeTiles?.has(`${t.tileX},${t.tileY}`));
                const fastResult = crossesBridge
                    ? this._lookahead(this._simplify(fastTiles, bridgeTiles), bridgeTiles)
                    : [{ tileX: target.tileX, tileY: target.tileY }];
                this._cacheResult(cacheKey, fastResult);
                return fastResult;
            }
        }

        // BFS — index-pointer queue (O(n)) and integer target set (no string allocation).
        const N = MAP_SIZE;
        const visited = new Uint8Array(N * N);
        const parent = new Int32Array(N * N).fill(-1);
        const targetSet = new Set(targetCandidates.map(({ tileX, tileY }) => tileY * N + tileX));
        const queue = [fy * N + fx];
        let head = 0;
        visited[fy * N + fx] = 1;
        let foundIdx = -1;
        while (head < queue.length) {
            const cur = queue[head++];
            if (targetSet.has(cur)) {
                foundIdx = cur;
                break;
            }
            const cx = cur % N;
            const cy = (cur - cx) / N;
            for (const [dx, dy] of DIRS) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                // Corner-cut guard: diagonal step requires both axis-aligned neighbors walkable.
                if (dx !== 0 && dy !== 0 && (!this.isWalkable(cx + dx, cy) || !this.isWalkable(cx, cy + dy))) continue;
                const idx = ny * N + nx;
                if (visited[idx]) continue;
                if (!this.isWalkable(nx, ny)) continue;
                visited[idx] = 1;
                parent[idx] = cur;
                queue.push(idx);
            }
        }
        if (foundIdx === -1) {
            console.warn('[Pathfinder] no path from', fx, fy, 'to nearest of', targetCandidates.length, 'candidates; closest:', JSON.stringify(targetCandidates[0]));
            return [];
        }

        // Reconstruct path from to -> from.
        const tiles = [];
        let cur = foundIdx;
        while (cur !== -1 && cur !== fy * N + fx) {
            tiles.push({ tileX: cur % N, tileY: (cur - (cur % N)) / N });
            cur = parent[cur];
        }
        tiles.reverse();
        const result = this._lookahead(this._simplify(tiles, bridgeTiles), bridgeTiles);
        this._cacheResult(cacheKey, result);
        return result;
    }

    _walkableCandidates(tileX, tileY) {
        if (this.isWalkable(tileX, tileY)) return [{ tileX, tileY }];

        const candidates = [];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = tileX + dx;
                const ny = tileY + dy;
                if (this.isWalkable(nx, ny)) candidates.push({ tileX: nx, tileY: ny });
            }
        }
        return candidates;
    }

    _findWeightedPath(fx, fy, targetCandidates, bridgeTiles, pathOptions) {
        const N = MAP_SIZE;
        const startIdx = fy * N + fx;
        const targetSet = new Set(targetCandidates.map(({ tileX, tileY }) => tileY * N + tileX));
        const visited = new Uint8Array(N * N);
        const parent = new Int32Array(N * N).fill(-1);
        const cost = new Float64Array(N * N);
        cost.fill(Infinity);
        cost[startIdx] = 0;
        const heap = [];
        this._heapPush(heap, { idx: startIdx, cost: 0 });

        let foundIdx = -1;
        while (heap.length > 0) {
            const current = this._heapPop(heap);
            if (!current || visited[current.idx]) continue;
            if (current.cost > cost[current.idx]) continue;
            visited[current.idx] = 1;
            if (targetSet.has(current.idx)) {
                foundIdx = current.idx;
                break;
            }

            const cx = current.idx % N;
            const cy = (current.idx - cx) / N;
            for (const [dx, dy] of DIRS) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                if (dx !== 0 && dy !== 0 && (!this.isWalkable(cx + dx, cy) || !this.isWalkable(cx, cy + dy))) continue;
                if (!this.isWalkable(nx, ny)) continue;
                const nextIdx = ny * N + nx;
                if (visited[nextIdx]) continue;
                const stepCost = this._weightedStepCost(cx, cy, nx, ny, dx, dy, bridgeTiles, pathOptions);
                const nextCost = current.cost + stepCost;
                if (nextCost >= cost[nextIdx]) continue;
                cost[nextIdx] = nextCost;
                parent[nextIdx] = current.idx;
                this._heapPush(heap, { idx: nextIdx, cost: nextCost });
            }
        }

        if (foundIdx === -1) return [];

        const tiles = [];
        let cur = foundIdx;
        while (cur !== -1 && cur !== startIdx) {
            tiles.push({ tileX: cur % N, tileY: (cur - (cur % N)) / N });
            cur = parent[cur];
        }
        tiles.reverse();
        return this._simplify(tiles, bridgeTiles);
    }

    _weightedStepCost(cx, cy, nx, ny, dx, dy, bridgeTiles, pathOptions) {
        const diagonal = dx !== 0 && dy !== 0;
        const base = diagonal ? 1.414 : 1;
        const fromWeight = this._tileTravelWeight(cx, cy, bridgeTiles, pathOptions);
        const toWeight = this._tileTravelWeight(nx, ny, bridgeTiles, pathOptions);
        return base * Math.min(fromWeight, toWeight);
    }

    _tileTravelWeight(tileX, tileY, bridgeTiles, pathOptions) {
        const key = `${tileX},${tileY}`;
        let weight = 1;
        if (bridgeTiles?.has(key) || pathOptions.bridgeTiles?.has(key)) weight = TILE_WEIGHTS.bridge;
        else if (pathOptions.dockTiles?.has(key)) weight = TILE_WEIGHTS.dock;
        else if (pathOptions.plazaTiles?.has(key)) weight = TILE_WEIGHTS.plaza;
        else if (pathOptions.roadTiles?.has(key) || pathOptions.preferredTiles?.has(key)) weight = TILE_WEIGHTS.road;
        if (pathOptions.laneTiles?.has(key)) weight = Math.min(weight, TILE_WEIGHTS.lane);
        if (pathOptions.avoidTiles?.has(key)) weight += TILE_WEIGHTS.avoid;
        const congestion = Number(pathOptions.congestionTiles?.get?.(key) || 0);
        if (congestion > 0) {
            weight += Math.min(TILE_WEIGHTS.congestionMax, congestion * TILE_WEIGHTS.congestionStep);
        }
        return weight;
    }

    _normalizePathOptions(options, bridgeTiles) {
        const roadTiles = this._normalizeTileSet(options?.roadTiles);
        const preferredTiles = this._normalizeTileSet(options?.preferredTiles);
        const plazaTiles = this._normalizeTileSet(options?.plazaTiles);
        const dockTiles = this._normalizeTileSet(options?.dockTiles);
        const laneTiles = this._normalizeTileSet(options?.laneTiles);
        const avoidTiles = this._normalizeTileSet(options?.avoidTiles);
        const congestionTiles = this._normalizeTileWeights(options?.congestionTiles);
        const optionBridgeTiles = this._normalizeTileSet(options?.bridgeTiles);
        const bridgeCount = optionBridgeTiles?.size || bridgeTiles?.size || 0;
        const weighted = (
            (roadTiles?.size || 0) +
            (preferredTiles?.size || 0) +
            (plazaTiles?.size || 0) +
            (dockTiles?.size || 0) +
            (laneTiles?.size || 0) +
            (avoidTiles?.size || 0) +
            (congestionTiles?.size || 0) +
            bridgeCount
        ) > 0;
        return {
            weighted: !!options?.preferRoads || weighted,
            cacheKey: options?.cacheKey || '',
            congestionVersion: options?.congestionVersion || options?.crowdVersion || '',
            roadTiles,
            preferredTiles,
            plazaTiles,
            dockTiles,
            laneTiles,
            avoidTiles,
            congestionTiles,
            bridgeTiles: optionBridgeTiles,
        };
    }

    _normalizeTileSet(input) {
        if (!input) return null;
        if (input instanceof Set) return input;
        if (input instanceof Map) return new Set(input.keys());
        if (!Array.isArray(input)) return null;
        const out = new Set();
        for (const tile of input) {
            if (typeof tile === 'string') {
                out.add(tile);
                continue;
            }
            const tileX = Number(tile?.tileX ?? tile?.x);
            const tileY = Number(tile?.tileY ?? tile?.y);
            if (Number.isFinite(tileX) && Number.isFinite(tileY)) out.add(`${Math.round(tileX)},${Math.round(tileY)}`);
        }
        return out;
    }

    _normalizeTileWeights(input) {
        if (!input) return null;
        const out = new Map();
        const add = (tile, weight = 1) => {
            if (typeof tile === 'string') {
                const value = Number(weight);
                if (Number.isFinite(value) && value > 0) out.set(tile, value);
                return;
            }
            const tileX = Number(tile?.tileX ?? tile?.x);
            const tileY = Number(tile?.tileY ?? tile?.y);
            const value = Number(tile?.weight ?? tile?.pressure ?? tile?.count ?? weight);
            if (Number.isFinite(tileX) && Number.isFinite(tileY) && Number.isFinite(value) && value > 0) {
                out.set(`${Math.round(tileX)},${Math.round(tileY)}`, value);
            }
        };

        if (input instanceof Map) {
            for (const [key, value] of input.entries()) add(key, value);
        } else if (Array.isArray(input)) {
            for (const entry of input) {
                if (Array.isArray(entry)) add(entry[0], entry[1]);
                else add(entry, 1);
            }
        } else if (typeof input === 'object') {
            for (const [key, value] of Object.entries(input)) add(key, value);
        }

        return out.size > 0 ? out : null;
    }

    _pathOptionsCacheKey(pathOptions) {
        if (!pathOptions.weighted) return '';
        if (pathOptions.cacheKey) return `|${pathOptions.cacheKey}`;
        return `|weighted:${pathOptions.roadTiles?.size || 0}:${pathOptions.preferredTiles?.size || 0}:${pathOptions.plazaTiles?.size || 0}:${pathOptions.dockTiles?.size || 0}:${pathOptions.laneTiles?.size || 0}:${pathOptions.avoidTiles?.size || 0}:${pathOptions.congestionTiles?.size || 0}:${pathOptions.bridgeTiles?.size || 0}:${pathOptions.congestionVersion}`;
    }

    describeRoute(tiles, options = null) {
        const list = Array.isArray(tiles) ? tiles : [];
        const pathOptions = this._normalizePathOptions(options, options?.bridgeTiles || null);
        let roadSteps = 0;
        let bridgeSteps = 0;
        let laneSteps = 0;
        let congestion = 0;
        for (const tile of list) {
            const tileX = Math.round(Number(tile?.tileX ?? tile?.x));
            const tileY = Math.round(Number(tile?.tileY ?? tile?.y));
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
            const key = `${tileX},${tileY}`;
            if (pathOptions.roadTiles?.has(key) || pathOptions.preferredTiles?.has(key)) roadSteps++;
            if (pathOptions.bridgeTiles?.has(key)) bridgeSteps++;
            if (pathOptions.laneTiles?.has(key)) laneSteps++;
            congestion += Number(pathOptions.congestionTiles?.get?.(key) || 0);
        }
        return {
            steps: list.length,
            roadSteps,
            bridgeSteps,
            laneSteps,
            congestion,
            roadShare: list.length ? roadSteps / list.length : 0,
        };
    }

    _heapPush(heap, item) {
        heap.push(item);
        let index = heap.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (heap[parent].cost <= item.cost) break;
            heap[index] = heap[parent];
            index = parent;
        }
        heap[index] = item;
    }

    _heapPop(heap) {
        if (heap.length === 0) return null;
        const root = heap[0];
        const last = heap.pop();
        if (heap.length > 0 && last) {
            let index = 0;
            while (true) {
                const left = index * 2 + 1;
                const right = left + 1;
                if (left >= heap.length) break;
                const child = right < heap.length && heap[right].cost < heap[left].cost ? right : left;
                if (heap[child].cost >= last.cost) break;
                heap[index] = heap[child];
                index = child;
            }
            heap[index] = last;
        }
        return root;
    }

    _lineWalkable(x0, y0, x1, y1) {
        return !!this._lineWalkableTiles(x0, y0, x1, y1);
    }

    _lineWalkableTiles(x0, y0, x1, y1) {
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        let cx = x0;
        let cy = y0;
        const tiles = [];
        while (true) {
            if (!this.isWalkable(cx, cy)) return null;
            tiles.push({ tileX: cx, tileY: cy });
            if (cx === x1 && cy === y1) return tiles;
            const e2 = 2 * err;
            if (e2 > -dy && e2 < dx) {
                // Diagonal step — check both corner tiles to prevent corner-cutting.
                if (!this.isWalkable(cx + sx, cy) || !this.isWalkable(cx, cy + sy)) return null;
                err -= dy; cx += sx;
                err += dx; cy += sy;
            } else {
                if (e2 > -dy) { err -= dy; cx += sx; }
                if (e2 < dx) { err += dx; cy += sy; }
            }
        }
    }

    _simplify(tiles, bridgeTiles) {
        if (tiles.length <= 1) return tiles;
        const out = [];
        let prevDir = null;
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            const next = tiles[i + 1];
            const onBridge = bridgeTiles?.has(`${t.tileX},${t.tileY}`);
            if (!next) {
                out.push(t); // always include final destination
                break;
            }
            const dir = `${Math.sign(next.tileX - t.tileX)},${Math.sign(next.tileY - t.tileY)}`;
            if (onBridge || dir !== prevDir) {
                out.push(t);
            }
            prevDir = dir;
        }
        return out;
    }

    _lookahead(tiles, bridgeTiles) {
        if (tiles.length <= 2) return tiles;
        const out = [tiles[0]];
        let i = 0;
        while (i < tiles.length - 1) {
            // Find the furthest waypoint reachable via a clear straight line from tiles[i].
            let j = tiles.length - 1;
            while (j > i + 1) {
                // Never skip over bridge tiles — they must remain explicit waypoints.
                const hasBridge = tiles.slice(i + 1, j).some(
                    t => bridgeTiles?.has(`${t.tileX},${t.tileY}`)
                );
                if (!hasBridge && this._lineWalkable(
                    tiles[i].tileX, tiles[i].tileY,
                    tiles[j].tileX, tiles[j].tileY,
                )) break;
                j--;
            }
            out.push(tiles[j]);
            i = j;
        }
        return out;
    }
}
