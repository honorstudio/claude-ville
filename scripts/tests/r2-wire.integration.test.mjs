import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { WeatherRenderer } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';

test('AgentSprite renders provenance-tagged speech and never recomposes tool copy', () => {
    const now = Date.now();
    const agent = new Agent({
        id: 'wire-dialogue-agent',
        provider: 'codex',
        status: 'working',
        currentTool: 'Bash',
        currentToolInput: 'npm test',
        lastMessage: 'Implemented R2-12 in the forge',
        dialogue: {
            text: 'Check vendor import path and JS syntax',
            full: null,
            kind: 'intent',
            source: 'claude.bash.description',
            fidelity: 'verbatim',
            redacted: false,
            observedAt: now,
            actionId: 'toolu_1',
        },
    });
    // A live intent must not put words in the agent's mouth any more.
    const manager = new VisitIntentManager({ now: () => now });
    manager.reconcile([agent], now);

    const spriteConsumer = {
        _providerTrimColor: () => '#7dd3fc',
        _statusVisualFor: () => ({ label: 'WORKING', color: '#7dd3fc' }),
    };
    const entry = AgentSprite.prototype._activityEntryForAgent.call(
        spriteConsumer,
        agent,
        now,
    );

    // The model's own sentence, untruncated by the domain layer.
    assert.equal(entry.text, 'Check vendor import path and JS syntax');
    assert.equal(entry.kind, 'intent');
    assert.equal(entry.shape, 'bubble');
    assert.equal(entry.source, 'claude.bash.description');
    assert.equal(entry.fidelity, 'verbatim');
    assert.ok(entry.badge, 'model-authored text carries a provenance badge');
    // The raw command and the assistant prose are both present on the agent and
    // must never be promoted into speech.
    assert.doesNotMatch(entry.text, /npm test|running bash|Implemented R2-12/i);

    // With no dialogue there is no entry at all: silence, not a status label
    // wearing bubble styling. Status stays visible through glyphs elsewhere.
    agent.dialogue = null;
    assert.equal(AgentSprite.prototype._activityEntryForAgent.call(spriteConsumer, agent, now), null);
    manager.dispose();
});

test('district atmosphere paints a cached local wash around project occupants', () => {
    let textureCreations = 0;
    const gradientStops = [];
    const canvasFactory = () => {
        textureCreations++;
        return {
            width: 0,
            height: 0,
            getContext() {
                return {
                    fillStyle: '',
                    createRadialGradient() {
                        return {
                            addColorStop(offset, color) { gradientStops.push([offset, color]); },
                        };
                    },
                    fillRect() {},
                };
            },
        };
    };
    const drawCalls = [];
    const ctx = {
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        save() {},
        restore() { this.globalAlpha = 1; },
        drawImage(...args) { drawCalls.push(args); },
    };
    const renderer = new WeatherRenderer({ canvasFactory });
    renderer.setDistrictContext({
        camera: { x: 0, y: 0, zoom: 1 },
        agentSprites: new Map([
            ['troubled-a', { x: 300, y: 220 }],
            ['troubled-b', { x: 340, y: 230 }],
            ['unrelated', { x: 1000, y: 600 }],
        ]),
    });
    const atmosphere = {
        motion: { particleEnabled: false },
        weather: { type: 'clear', intensity: 0, precipitation: 0, fog: 0, cloudCover: 0 },
        districtAtmosphere: [{
            project: '/repos/troubled',
            agentIds: ['troubled-a', 'troubled-b'],
            groundHaze: { alpha: 0.2, tint: '76, 68, 94' },
            lightingBias: { cool: 0.15, warm: 0, dim: 0.1 },
            falloff: { shape: 'smoothstep', innerRadiusTiles: 2.5, outerRadiusTiles: 7 },
        }],
    };

    renderer.drawForeground(ctx, { canvas: { width: 1280, height: 720 }, atmosphere });
    const firstTextureCount = textureCreations;

    assert.equal(renderer._lastDistrictDrawCount, 1);
    assert.equal(drawCalls.length, 3);
    assert.ok(drawCalls.every(([, x, y, width, height]) => (
        x > 0 && y > 0 && width < 1280 && height < 720
    )));
    assert.ok(gradientStops.some(([offset]) => offset > 0 && offset < 1));

    // Reduced motion uses the same fixed visual and reuses its texture cache.
    renderer.drawForeground(ctx, { canvas: { width: 1280, height: 720 }, atmosphere });
    assert.equal(renderer._lastDistrictDrawCount, 1);
    assert.equal(textureCreations, firstTextureCount);
    renderer.dispose();
});
