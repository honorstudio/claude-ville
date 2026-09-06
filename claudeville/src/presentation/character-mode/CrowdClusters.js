export function dominantCountKey(counts) {
    let bestKey = null;
    let bestCount = -1;
    for (const [key, count] of Object.entries(counts || {})) {
        if (count > bestCount || (count === bestCount && key.localeCompare(bestKey || '') < 0)) {
            bestKey = key;
            bestCount = count;
        }
    }
    return bestKey;
}

export function summarizeCrowdClusterEntries(entries, {
    cellSize = 4,
    topLimit = 12,
    includeStatusCounts = false,
    includeDominantProvider = false,
    includeTeamCount = true,
} = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) {
        return {
            clusters: [],
            minClusterSize: 3,
            maxClusterSize: 0,
            congestedAgents: 0,
        };
    }

    const size = Math.max(1, Number(cellSize) || 4);
    const groups = new Map();
    for (const entry of list) {
        const tileX = Number(entry?.tileX);
        const tileY = Number(entry?.tileY);
        if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
        const cellX = Math.floor(tileX / size);
        const cellY = Math.floor(tileY / size);
        const key = `${cellX},${cellY}`;
        const group = groups.get(key) || {
            id: key,
            cellX,
            cellY,
            count: 0,
            moving: 0,
            sumTileX: 0,
            sumTileY: 0,
            statuses: {},
            providers: {},
            teams: new Set(),
        };
        group.count++;
        if (entry.moving) group.moving++;
        group.sumTileX += tileX;
        group.sumTileY += tileY;
        const status = entry.status || 'unknown';
        group.statuses[status] = (group.statuses[status] || 0) + 1;
        if (entry.provider) {
            const provider = entry.provider || 'unknown';
            group.providers[provider] = (group.providers[provider] || 0) + 1;
        }
        if (entry.teamName) group.teams.add(entry.teamName);
        groups.set(key, group);
    }

    const minClusterSize = list.length >= 90 ? 6 : list.length >= 50 ? 5 : 3;
    const clusters = Array.from(groups.values())
        .filter(group => group.count >= minClusterSize)
        .map(group => {
            const cluster = {
                id: group.id,
                tileX: group.sumTileX / group.count,
                tileY: group.sumTileY / group.count,
                count: group.count,
                moving: group.moving,
                dominantStatus: dominantCountKey(group.statuses),
            };
            if (includeStatusCounts) cluster.statuses = group.statuses;
            if (includeDominantProvider) cluster.dominantProvider = dominantCountKey(group.providers);
            if (includeTeamCount) cluster.teamCount = group.teams.size;
            return cluster;
        })
        .sort((a, b) => (b.count - a.count) || a.id.localeCompare(b.id))
        .slice(0, Math.max(0, Number(topLimit) || 0));

    return {
        clusters,
        minClusterSize,
        maxClusterSize: clusters.reduce((max, cluster) => Math.max(max, cluster.count || 0), 0),
        congestedAgents: clusters.reduce((sum, cluster) => sum + (cluster.count || 0), 0),
    };
}
