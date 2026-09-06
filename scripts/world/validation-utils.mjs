export function createReporter(label) {
    const issues = [];
    return {
        error(path, message) {
            issues.push({ level: 'error', path, message });
        },
        warn(path, message) {
            issues.push({ level: 'warn', path, message });
        },
        printSuccess(message) {
            console.log(`${label}: ${message}`);
        },
        finish(successMessage) {
            for (const issue of issues) {
                const prefix = issue.level === 'error' ? 'ERROR' : 'WARN';
                console.log(`${prefix} ${issue.path}: ${issue.message}`);
            }
            const errorCount = issues.filter((issue) => issue.level === 'error').length;
            const warnCount = issues.length - errorCount;
            if (errorCount > 0) {
                console.error(`${label}: failed with ${errorCount} error(s), ${warnCount} warning(s)`);
                process.exitCode = 1;
                return false;
            }
            console.log(`${label}: passed${warnCount ? ` with ${warnCount} warning(s)` : ''}`);
            if (successMessage) console.log(successMessage);
            return true;
        },
    };
}

export function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
}

export function isPositiveNumber(value) {
    return isFiniteNumber(value) && Number(value) > 0;
}

export function tileKey(tileX, tileY) {
    return `${tileX},${tileY}`;
}

export function inTileBounds(tileX, tileY, mapSize) {
    return isFiniteNumber(tileX)
        && isFiniteNumber(tileY)
        && Number(tileX) >= 0
        && Number(tileX) < mapSize
        && Number(tileY) >= 0
        && Number(tileY) < mapSize;
}

export function rectInsideMap(rect, mapSize) {
    return isFiniteNumber(rect.x0)
        && isFiniteNumber(rect.y0)
        && isFiniteNumber(rect.x1)
        && isFiniteNumber(rect.y1)
        && rect.x0 >= 0
        && rect.y0 >= 0
        && rect.x1 < mapSize
        && rect.y1 < mapSize
        && rect.x0 <= rect.x1
        && rect.y0 <= rect.y1;
}

export function buildingRect(building) {
    return {
        x0: Number(building.x),
        y0: Number(building.y),
        x1: Number(building.x) + Number(building.width) - 1,
        y1: Number(building.y) + Number(building.height) - 1,
    };
}

export function walkExclusionRect(building, exclusion) {
    const x0 = isFiniteNumber(exclusion.x)
        ? Number(exclusion.x)
        : Number(building.x) + Number(exclusion.dx || 0);
    const y0 = isFiniteNumber(exclusion.y)
        ? Number(exclusion.y)
        : Number(building.y) + Number(exclusion.dy || 0);
    const width = Math.floor(Number(exclusion.width || 1));
    const height = Math.floor(Number(exclusion.height || 1));
    return {
        x0: Math.floor(x0),
        y0: Math.floor(y0),
        x1: Math.floor(x0) + width - 1,
        y1: Math.floor(y0) + height - 1,
        width,
        height,
    };
}

export function rectsOverlap(left, right) {
    return left.x0 <= right.x1
        && left.x1 >= right.x0
        && left.y0 <= right.y1
        && left.y1 >= right.y0;
}
