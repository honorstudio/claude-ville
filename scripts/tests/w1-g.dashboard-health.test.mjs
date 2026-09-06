import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    SECTION_HEALTH_ORDER,
    nonZeroSectionHealthBuckets,
    sectionHealthCounts,
    shouldFlashForStatus,
} from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';

const rendererUrl = new URL('../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js', import.meta.url);
const dashboardCssUrl = new URL('../../claudeville/css/dashboard.css', import.meta.url);

test('section health keeps all six SignalLedger buckets distinct', () => {
    const agents = [
        { id: 'error', status: 'errored' },
        { id: 'blocked', status: 'waiting_on_user' },
        { id: 'quota', status: 'rate_limited' },
        { id: 'working', status: 'working' },
        { id: 'waiting', status: 'waiting' },
        { id: 'completed', status: 'completed' },
    ];

    const counts = sectionHealthCounts(agents);

    assert.deepEqual(counts, {
        errors: 1,
        needsYou: 1,
        quota: 1,
        working: 1,
        watchlist: 1,
        idle: 1,
    });
    assert.equal(counts.errors, 1, 'blocked and quota agents must not increment errors');
});

test('section edge flash is reserved for genuine errors', () => {
    assert.equal(shouldFlashForStatus('errored'), true);
    assert.equal(shouldFlashForStatus('waiting_on_user'), false);
    assert.equal(shouldFlashForStatus('rate_limited'), false);
});

test('health buckets retain stable order and omit zero counts', () => {
    assert.deepEqual(SECTION_HEALTH_ORDER, [
        'errors',
        'needsYou',
        'quota',
        'working',
        'watchlist',
        'idle',
    ]);
    assert.deepEqual(nonZeroSectionHealthBuckets({
        errors: 1,
        needsYou: 0,
        quota: 2,
        working: 0,
        watchlist: 3,
        idle: 0,
    }), ['errors', 'quota', 'watchlist']);
});

test('dashboard CSS covers every emitted health-strip class without width media queries', async () => {
    const [rendererSource, dashboardCss] = await Promise.all([
        readFile(rendererUrl, 'utf8'),
        readFile(dashboardCssUrl, 'utf8'),
    ]);
    const presentationSource = rendererSource.match(
        /const SECTION_HEALTH_PRESENTATION = Object\.freeze\(\{([\s\S]*?)\n\}\);/,
    )?.[1];

    assert.ok(presentationSource, 'health presentation map must remain discoverable');
    const suffixes = [...presentationSource.matchAll(/className: '([^']+)'/g)]
        .map(match => match[1]);
    assert.equal(suffixes.length, SECTION_HEALTH_ORDER.length);

    const emittedClasses = [
        'dashboard__section-health',
        'dashboard__section-healthbar',
        'dashboard__section--errored-flash',
        'dashboard__health-stat',
        'dashboard__healthbar-seg',
        ...suffixes.flatMap(suffix => [
            `dashboard__health-stat--${suffix}`,
            `dashboard__healthbar-seg--${suffix}`,
        ]),
    ];
    for (const className of emittedClasses) {
        assert.match(
            dashboardCss,
            new RegExp(`\\.${className.replaceAll('-', '\\-')}(?![\\w-])`),
            `missing dashboard CSS for .${className}`,
        );
    }

    assert.doesNotMatch(dashboardCss, /@media[^\{]*(?:min|max)-width\s*:/i);
});


test('avatar fit preserves wide and tall silhouettes within native niche bounds', async () => {
    const { fitAvatarFrame } = await import('../../claudeville/src/presentation/dashboard-mode/AvatarCanvas.js');
    for (const [width, height] of [[92, 30], [20, 92], [60, 60], [180, 110]]) {
        for (const [maxWidth, maxHeight, integer] of [[40, 46, false], [88, 82, true]]) {
            const fit = fitAvatarFrame(width, height, maxWidth, maxHeight, integer);
            assert.ok(fit.width <= maxWidth && fit.height <= maxHeight);
            assert.ok(Math.abs(fit.width / fit.height - width / height) <= (1 + width / height) / fit.height);
        }
    }
});

test('unknown CLI badges and stale detail never claim another provider or fresh data', async () => {
    const { providerPresentation, detailFreshnessLabel, signalProvenance } = await import('../../claudeville/src/presentation/shared/AgentPresentation.js');
    assert.equal(providerPresentation('new-cli').badge.label, 'new-cli');
    assert.equal(providerPresentation().badge.label, 'Unknown');
    const now = 100000;
    assert.equal(detailFreshnessLabel({}, { hasEntry: true, isFresh: false, entry: { at: now - 12000 } }, now), 'Cached · updated 12s ago');
    assert.equal(detailFreshnessLabel({}, { hasEntry: true, isFresh: true, value: { freshness: { state: 'stale', observedAt: now - 30000 } } }, now), 'Cached · updated 30s ago');
    assert.equal(detailFreshnessLabel({}, { hasEntry: true, isFresh: true }, now), '');
    assert.equal(signalProvenance({ signalSource: 'hook', signalCertainty: 'observed', signalStale: true }), 'HOOK · observed · stale');
});

test('dashboard cost keeps unavailable billing distinct from observed zero', async () => {
    const { DashboardRenderer } = await import('../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js');
    const footer = agent => DashboardRenderer.prototype._usageFooterFor.call({}, agent, null);
    assert.equal(footer({ tokens: { availability: 'unavailable', contextWindow: 2000 }, provider: 'grok' }).cost, 'Cost unavailable');
    assert.match(footer({ tokens: { availability: 'observed', input: 0, output: 0 }, provider: 'codex' }).cost, /0/);
});

test('seven-provider fixture retains hosted identity, stale certainty and unavailable versus zero usage', async () => {
    const { default: AgentSimulator } = await import('../../claudeville/src/presentation/character-mode/__simfixture__/AgentSimulator.js');
    const agents = new Map();
    const world = { addAgent: agent => agents.set(agent.id, agent), removeAgent: id => agents.delete(id) };
    const simulator = new AgentSimulator({ world, scenarioId: 'multi-provider-showcase' });
    simulator.start();
    try {
        assert.equal(new Set([...agents.values()].map(agent => agent.provider)).size, 7);
        assert.equal(agents.get('showcase-omp').underlyingProvider, 'zai');
        assert.equal(agents.get('showcase-opencode').underlyingProvider, 'openai');
        assert.equal(agents.get('showcase-grok').cost.usd, null);
        assert.equal(agents.get('showcase-grok').freshness.state, 'stale');
        assert.equal(agents.get('showcase-codex').tokens.availability, 'observed');
        assert.equal(agents.get('showcase-codex').cost.usd, 0);
        assert.equal(agents.get('showcase-codex').signalCertainty, 'observed');
        assert.equal(agents.get('showcase-codex').signalStale, true);
        assert.equal(agents.get('showcase-gemini').tokens.availability, 'partial');
    } finally {
        simulator.stop();
    }
});
