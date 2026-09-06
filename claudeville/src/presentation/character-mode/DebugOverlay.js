import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { WORLD_BODY_FONT } from '../../config/theme.js';
import { CANVAS_BUDGET } from './CanvasBudget.js';

export class DebugOverlay {
    constructor() {
        this.enabled = false;
        this.pathDebugEnabled = false;
        this._backendRows = null;
        this._backendRowsAt = 0;
    }

    toggle() {
        this.enabled = !this.enabled;
    }

    togglePathDebug() {
        this.pathDebugEnabled = !this.pathDebugEnabled;
    }

    draw(ctx, { walkabilityGrid, bridgeTiles, agentSprites, buildings, sceneryZones, treeProps, boulderProps, visitIntents, visitReservations, buildingRenderer }) {
        if (!this.enabled) return;

        // Walkability tint: green = walkable, red = blocked, yellow = bridge.
        ctx.save();
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const wx = (x - y) * TILE_WIDTH / 2;
                const wy = (x + y) * TILE_HEIGHT / 2;
                const walkable = walkabilityGrid[y * MAP_SIZE + x] === 1;
                const isBridge = bridgeTiles?.has(`${x},${y}`);
                ctx.globalAlpha = 0.28;
                ctx.fillStyle = isBridge ? '#f2d36b' : walkable ? '#4caf50' : '#f44336';
                ctx.fillRect(wx - TILE_WIDTH / 4, wy - TILE_HEIGHT / 4, TILE_WIDTH / 2, TILE_HEIGHT / 2);
            }
        }
        ctx.restore();

        // Building footprints and tall-scenery sightline exclusions.
        ctx.save();
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.9;
        if (buildings) {
            ctx.strokeStyle = '#ff9800';
            for (const building of buildings.values()) {
                this._strokeTileRect(ctx, {
                    x0: building.position.tileX,
                    y0: building.position.tileY,
                    x1: building.position.tileX + building.width,
                    y1: building.position.tileY + building.height,
                });
                const rects = typeof building.walkExclusionRects === 'function'
                    ? building.walkExclusionRects()
                    : [];
                ctx.strokeStyle = 'rgba(255, 193, 7, 0.95)';
                for (const rect of rects) {
                    this._strokeTileRect(ctx, {
                        x0: rect.x0,
                        y0: rect.y0,
                        x1: rect.x1 + 1,
                        y1: rect.y1 + 1,
                    });
                }
                ctx.strokeStyle = '#ff9800';
            }
        }
        if (Array.isArray(sceneryZones)) {
            for (const zone of sceneryZones) {
                ctx.strokeStyle = 'rgba(255, 64, 129, 0.92)';
                this._strokeTileRect(ctx, zone.padded);
                if (zone.sightline) {
                    ctx.strokeStyle = 'rgba(171, 71, 188, 0.82)';
                    this._strokeTileRect(ctx, zone.sightline);
                }
            }
        }
        ctx.restore();

        buildingRenderer?.drawGroundingDebug?.(ctx);

        // Tall prop anchors.
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#00e676';
        for (const prop of treeProps || []) this._drawAnchor(ctx, prop.tileX, prop.tileY, 2.5);
        ctx.fillStyle = '#b0bec5';
        for (const prop of boulderProps || []) this._drawAnchor(ctx, prop.tileX, prop.tileY, 2);
        ctx.restore();

        // Per-agent waypoint polylines.
        ctx.save();
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.75;
        for (const sprite of agentSprites.values()) {
            if (!sprite.waypoints?.length) continue;
            ctx.beginPath();
            ctx.moveTo(sprite.x, sprite.y);
            for (const wp of sprite.waypoints) ctx.lineTo(wp.x, wp.y);
            ctx.stroke();
        }
        ctx.restore();

        // Visit target markers.
        const reservations = Array.isArray(visitReservations?.reservations) ? visitReservations.reservations : [];
        ctx.save();
        ctx.lineWidth = 1.5;
        ctx.font = `10px ${WORLD_BODY_FONT}`;
        ctx.textBaseline = 'bottom';
        for (const reservation of reservations) {
            const point = this._tileToScreen(reservation.tileX, reservation.tileY);
            ctx.strokeStyle = reservation.overflow ? '#ffeb3b' : '#00e5ff';
            ctx.fillStyle = 'rgba(23, 32, 42, 0.82)';
            ctx.beginPath();
            ctx.arc(point.x, point.y - 4, 6, 0, Math.PI * 2);
            ctx.stroke();
            const label = `${reservation.buildingType || '?'}:${reservation.agentId || '?'}`.slice(0, 24);
            const width = ctx.measureText(label).width + 6;
            ctx.fillRect(point.x + 7, point.y - 21, width, 13);
            ctx.fillStyle = reservation.overflow ? '#fff59d' : '#80deea';
            ctx.fillText(label, point.x + 10, point.y - 10);
        }
        ctx.restore();
    }

    // Shift-P pathfinding overlay: planned paths as breadcrumb dots plus a
    // glowing diamond on each agent's destination tile. Independent of the
    // main shift-D overlay so paths stay readable without the walkability tint.
    drawPathDebug(ctx, { agentSprites } = {}) {
        if (!this.pathDebugEnabled || !agentSprites?.size) return;
        for (const sprite of agentSprites.values()) {
            const waypoints = Array.isArray(sprite.waypoints) ? sprite.waypoints : [];
            if (waypoints.length === 0) continue;
            const points = [{ x: sprite.x, y: sprite.y }, ...waypoints];
            this._drawDestinationGlow(ctx, points[points.length - 1], sprite.selected);
            this._drawBreadcrumbs(ctx, points);
        }
    }

    _drawDestinationGlow(ctx, point, selected) {
        const hw = TILE_WIDTH / 2;
        const hh = TILE_HEIGHT / 2;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = selected ? '#80deea' : '#ffd54f';
        for (const layer of [
            { scale: 1.5, alpha: 0.10 },
            { scale: 1.0, alpha: 0.22 },
            { scale: 0.55, alpha: 0.32 },
        ]) {
            ctx.globalAlpha = layer.alpha;
            this._traceDiamond(ctx, point.x, point.y, hw * layer.scale, hh * layer.scale);
            ctx.fill();
        }
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = selected ? '#b2ebf2' : '#ffe082';
        ctx.lineWidth = 1.2;
        this._traceDiamond(ctx, point.x, point.y, hw, hh);
        ctx.stroke();
        ctx.restore();
    }

    _drawBreadcrumbs(ctx, points, spacing = 22) {
        ctx.save();
        ctx.fillStyle = '#80deea';
        ctx.globalAlpha = 0.8;
        let carry = 0;
        for (let i = 1; i < points.length; i++) {
            const from = points[i - 1];
            const to = points[i];
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const length = Math.hypot(dx, dy);
            if (length < 0.001) continue;
            // Evenly spaced dots along the segment, carrying remainder across joints.
            let d = spacing - carry;
            while (d <= length) {
                const t = d / length;
                this._dot(ctx, from.x + dx * t, from.y + dy * t, 1.8);
                d += spacing;
            }
            carry = (carry + length) % spacing;
            // Slightly larger marker on each raw waypoint.
            this._dot(ctx, to.x, to.y, 2.6);
        }
        ctx.restore();
    }

    _traceDiamond(ctx, cx, cy, hw, hh) {
        ctx.beginPath();
        ctx.moveTo(cx, cy - hh);
        ctx.lineTo(cx + hw, cy);
        ctx.lineTo(cx, cy + hh);
        ctx.lineTo(cx - hw, cy);
        ctx.closePath();
    }

    _dot(ctx, x, y, radius) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    drawScreen(ctx, { renderer = null, visitIntents, visitReservations, agentSprites, viewport, panelY = 12, behaviorStats = null, renderStats = null, cameraState = null } = {}) {
        if (!this.enabled) return;
        const intents = Array.isArray(visitIntents?.intents) ? visitIntents.intents : [];
        const reservations = Array.isArray(visitReservations?.reservations) ? visitReservations.reservations : [];
        const buildingStats = visitReservations?.buildings || {};
        const layerRows = this._renderLayerRows(renderStats);
        const timingRows = this._renderTimingRows(renderStats);
        const rows = [
            `agents: ${agentSprites?.size || 0}`,
            `intents: ${intents.length}`,
            `reservations: ${reservations.length}`,
            this._cameraStateRow(viewport, cameraState),
            ...this._rendererBackendRows(renderer),
            ...this._trailRows(renderer),
            renderStats?.drawables ? `drawables: ${renderStats.drawables.total} drawn / ${renderStats.drawables.culling?.culled || 0} culled` : null,
            renderStats?.harbor ? `harbor: pending ${renderStats.harbor.pendingRepos || 0} commits ${renderStats.harbor.pendingCommits || 0} lanterns ${renderStats.harbor.bridgeLanterns || 0}` : null,
            renderStats?.canvas ? `light/cache: ${renderStats.canvas.lightGradients || 0} gradients / particles ${renderStats.canvas.particles || 0}` : null,
            renderStats?.director ? `director: scenes ${renderStats.director.activeScenes || 0}/${renderStats.director.sceneDrops || 0} drops · signals ${renderStats.director.buildingSignals || 0} · replay ${renderStats.director.replaySamples || 0}/${renderStats.director.replayPoints || 0}` : null,
            ...timingRows,
            ...layerRows,
            behaviorStats?.metricsScope ? `metrics: ${behaviorStats.metricsScope}` : null,
            behaviorStats?.behaviorMetrics ? `retarget/scenic/handoff: ${behaviorStats.behaviorMetrics.stationaryRetargets || 0}/${behaviorStats.behaviorMetrics.scenicVisits || 0}/${behaviorStats.behaviorMetrics.handoffIntents || 0}` : null,
            behaviorStats?.allocatorMetrics ? `alloc/renew/reject: ${behaviorStats.allocatorMetrics.allocations || 0}/${behaviorStats.allocatorMetrics.renewals || 0}/${behaviorStats.allocatorMetrics.rejected || 0}` : null,
            ...Object.entries(buildingStats)
                .filter(([, stat]) => (stat.occupied || stat.reserved) > 0)
                .slice(0, 12)
                .map(([type, stat]) => `${type}: occ ${stat.occupied} res ${stat.reserved}/${stat.capacity}`),
            ...intents.slice(0, 6).map((intent) => {
                const label = intent.label ? ` ${intent.label}` : '';
                return `${intent.agentId}: ${intent.building}/${intent.reason}${label}`;
            }),
            ...Array.from(agentSprites?.values?.() || [])
                .slice(0, 4)
                .map((sprite) => {
                    const snap = sprite.getBehaviorDebugSnapshot?.();
                    return snap ? `${snap.name || snap.agentId}: ${snap.behaviorState}/${snap.building || '?'}` : null;
                })
                .filter(Boolean),
        ].filter(Boolean);
        const padding = 8;
        const lineHeight = 14;
        ctx.save();
        ctx.font = `11px ${WORLD_BODY_FONT}`;
        // Per-pass timing rows are wider than the old 420 px cap, and fillText's
        // maxWidth squeezes rather than wraps: too narrow a panel makes the
        // numbers unreadable instead of merely cropped. 560 px still leaves the
        // right two thirds of a 1280 px viewport clear.
        const width = Math.min(
            560,
            Math.max(210, ...rows.map((row) => ctx.measureText(row).width + padding * 2)),
        );
        const height = rows.length * lineHeight + padding * 2;
        const x = 12;
        const y = panelY;

        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(20, 24, 31, 0.86)';
        ctx.strokeStyle = 'rgba(242, 211, 107, 0.72)';
        ctx.lineWidth = 1;
        ctx.fillRect(x, y, width, height);
        ctx.strokeRect(x + 0.5, y + 0.5, width, height);
        ctx.fillStyle = '#f5e6a8';
        rows.forEach((row, index) => {
            const maxWidth = (viewport?.width || width) - x - padding * 2;
            ctx.fillText(row, x + padding, y + padding + index * lineHeight, Math.max(120, Math.min(width - padding * 2, maxWidth)));
        });
        ctx.restore();
    }

    _renderLayerRows(renderStats) {
        const byKind = renderStats?.drawables?.byKind || {};
        return Object.entries(byKind)
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .slice(0, 6)
            .map(([kind, count]) => `layer ${kind}: ${count}`);
    }

    _renderTimingRows(renderStats) {
        const timings = Array.isArray(renderStats?.timings?.segments) ? renderStats.timings.segments : [];
        if (!timings.length) return [];
        const total = renderStats.timings.totalMs;
        const rows = [`frame: ${formatMs(total)}ms total`];
        for (const timing of timings.slice(0, 5)) {
            rows.push(`${timing.label}: ${formatMs(timing.ms)} p95 ${formatMs(timing.p95)}`);
        }
        return rows;
    }

    // Plan 1.9 — camera/frame readout. `cameraState` is a light snapshot shaped
    // from IsometricRenderer.getCanvasBudget() plus the live camera:
    //   { zoom, dpr, visibleCanvasPixels, maxMainCanvasPixels, owner, gliding }
    // Without it the row still reports effective DPR and backing px derived
    // from the viewport's own `_claudeVilleDpr`, so it renders with no caller
    // wiring; passing `cameraState` adds zoom and glide owner/state.
    _cameraStateRow(viewport, cameraState) {
        const dpr = Number(cameraState?.dpr) || Number(viewport?._claudeVilleDpr) || 0;
        const cssWidth = Number(viewport?.width) || 0;
        const cssHeight = Number(viewport?.height) || 0;
        if (!dpr || !cssWidth || !cssHeight) return null;
        const backing = Number(cameraState?.visibleCanvasPixels)
            || Math.round(cssWidth * dpr) * Math.round(cssHeight * dpr);
        const cap = Number(cameraState?.maxMainCanvasPixels) || CANVAS_BUDGET.maxMainCanvasPixels;
        const parts = [`dpr ${dpr}`, `backing ${formatPixels(backing)}/${formatPixels(cap)} px`];
        const zoom = Number(cameraState?.zoom);
        if (Number.isFinite(zoom)) parts.unshift(`zoom ${+zoom.toFixed(2)}`);
        if (cameraState?.owner) {
            parts.push(`owner ${cameraState.owner}${cameraState.gliding ? ' (glide)' : ''}`);
        }
        return `camera: ${parts.join(' · ')}`;
    }

    // One backend at a time: the resident GPU world and the hybrid PostFx
    // pipeline have different counters, and printing the inactive one's zeroes
    // beside the active one's timings is what made earlier readouts misleading.
    // Refreshed at 1 Hz so the numbers hold still long enough to read.
    _rendererBackendRows(renderer) {
        const now = performance.now();
        if (this._backendRows && now - this._backendRowsAt < 1000) return this._backendRows;
        this._backendRowsAt = now;
        const gpu = renderer?.gpuWorld?.getDiagnostics?.();
        this._backendRows = gpu?.active ? this._residentGpuRows(gpu) : this._hybridPostFxRows(renderer);
        return this._backendRows;
    }

    _residentGpuRows(gpu) {
        const resources = gpu.resources || {};
        return [
            `gpu world: level ${gpu.qualityLevel} · ${gpu.qualityReason} · ${gpu.records} records / ${gpu.batches} batches · ${gpu.lights} lights`,
            `gpu frame: whole ${formatMicroMs(gpu.gpuMs)} · cpu ${formatOptionalMs(gpu.cpuMs)} · gap ${formatOptionalMs(gpu.frameGapMs)} · source ${gpu.qualityTimingSource}`,
            `shed (${gpu.shedReason}): ${gpu.shedEffects.map((effect) => `${effect.id} ${effect.mode}`).join(', ') || 'none'}`,
            `pass sampling ${gpu.passSamplingEnabled ? 'on' : 'off'} · disjoint discards ${gpu.gpuDisjointDiscards} · timer errors ${gpu.gpuTimerErrors}`,
            ...Object.entries(gpu.passes).map(([name, pass]) => `  ${name}: gpu ${formatMicroMs(pass.gpuMs)}`
                + ` · cpu ${formatMicroMs(pass.cpuMs)} · ${pass.draws ?? 0} draws · ${formatBytes(pass.bytes)} · n=${pass.samples}`),
            `gpu bytes: pinned ${formatBytes(resources.pinnedBytes)} · evictable ${formatBytes(resources.evictableBytes)} · total ${formatBytes(resources.totalBytes)}`,
            `source cache: overage ${formatBytes(resources.cachedSourceOverageBytes)} · body atlas ${resources.liveBodyAtlas
                ? `${resources.liveBodyAtlas.width}x${resources.liveBodyAtlas.height}/channel`
                : 'absent'}`,
            ...(resources.atlasPages || []).map((page) => `  ${page.name}: ${page.width}x${page.height} · ${formatBytes(page.bytes)}`),
        ];
    }

    _hybridPostFxRows(renderer) {
        const diagnostics = renderer?.postFx?.getDiagnostics?.() || null;
        const feed = renderer?.postFxFeed?.getDiagnostics?.() || null;
        if (!diagnostics?.active) {
            return ['gpu world: inactive · GPU unavailable · CPU frame segments below'];
        }
        return [
            `postfx hybrid: level ${diagnostics.level} · ${diagnostics.ladder?.lastDecisionReason || 'n/a'}`
                + ` · last degrade ${diagnostics.ladder?.lastDegradationReason || 'none'}`,
            `postfx upload: source ${formatOptionalMs(diagnostics.uploadMs)} · mask ${formatOptionalMs(diagnostics.maskUploadMs)} · setup ${formatOptionalMs(diagnostics.setupCpuMs)}`,
            `postfx shader: cpu ${formatOptionalMs(diagnostics.shaderCpuMs)} · gpu ${diagnostics.gpuMs == null ? 'unavailable' : formatMicroMs(diagnostics.gpuMs)}`
                + ` · total cpu ${formatOptionalMs(diagnostics.renderTotalCpuMs)} · gap ${formatOptionalMs(diagnostics.frameGapMs)}`,
            `postfx bytes: textures ${formatBytes(diagnostics.resources?.groupTotals?.textures)} · attachments ${formatBytes(diagnostics.resources?.groupTotals?.attachments)}`
                + ` · total ${formatBytes(diagnostics.resources?.totalBytes ?? diagnostics.textureBytes)}`,
            feed ? `postfx feed: mask ${formatPixels(feed.maskPixels)} px · rebuild ${feed.maskRebuilds} reuse ${feed.maskReuses} · ${feed.maskLastReason} ${formatOptionalMs(feed.maskLastRepaintMs)}` : null,
        ].filter(Boolean);
    }

    _trailRows(renderer) {
        const trails = renderer?.trailRenderer?.getDiagnostics?.() || null;
        if (!trails) return [];
        const motion = trails.cameraMotion?.[trails.cameraMotionMode] || null;
        const averageDraw = motion?.frames > 0 ? motion.drawTimeMs / motion.frames : null;
        const averageRepaint = motion?.repaintCount > 0 ? motion.repaintTimeMs / motion.repaintCount : null;
        return [
            `trails: ${trails.renderPolicy?.historicalMode || 'n/a'} · cache ${trails.cacheSpace || 'none'} ${formatPixels(trails.highWaterCachePixels)} px · samples ${trails.totalSamples}/${trails.globalLimit}`,
            `trails camera: ${trails.cameraMotionMode || 'n/a'} · draw avg ${formatOptionalMs(averageDraw)} · repaint ${motion?.repaintCount || 0} avg ${formatOptionalMs(averageRepaint)}`,
            `trails semantic: selected ${trails.selectedOverlayDraws || 0} · action ${trails.actionOverlayDraws || 0} · oversized ${trails.oversizedCacheFallbacks || 0}`,
        ];
    }

    _tileToScreen(tileX, tileY) {
        return {
            x: (tileX - tileY) * TILE_WIDTH / 2,
            y: (tileX + tileY) * TILE_HEIGHT / 2,
        };
    }

    _strokeTileRect(ctx, rect) {
        const nw = this._tileToScreen(rect.x0, rect.y0);
        const ne = this._tileToScreen(rect.x1, rect.y0);
        const se = this._tileToScreen(rect.x1, rect.y1);
        const sw = this._tileToScreen(rect.x0, rect.y1);
        ctx.beginPath();
        ctx.moveTo(nw.x, nw.y);
        ctx.lineTo(ne.x, ne.y);
        ctx.lineTo(se.x, se.y);
        ctx.lineTo(sw.x, sw.y);
        ctx.closePath();
        ctx.stroke();
    }

    _drawAnchor(ctx, tileX, tileY, radius) {
        const p = this._tileToScreen(tileX, tileY);
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

function formatMs(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0.0';
    return number.toFixed(number >= 10 ? 0 : 1);
}

function formatOptionalMs(value) {
    if (value === null || value === undefined) return 'n/a';
    const number = Number(value);
    return Number.isFinite(number) ? `${formatMs(number)}ms` : 'n/a';
}

// Pass timings live in the tenths-of-a-microsecond range; `formatMs`'s one
// decimal would round most of them to 0.0 and hide the differences that
// justify (or refuse) a new effect.
function formatMicroMs(value) {
    if (value === null || value === undefined) return 'unavailable';
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(3)}ms` : 'unavailable';
}

function formatBytes(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '0 B';
    if (number >= 1_048_576) return `${(number / 1_048_576).toFixed(1)} MiB`;
    if (number >= 1_024) return `${Math.round(number / 1_024)} KiB`;
    return `${Math.round(number)} B`;
}

function formatPixels(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '0';
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
    if (number >= 1_000) return `${Math.round(number / 1_000)}k`;
    return String(Math.round(number));
}
