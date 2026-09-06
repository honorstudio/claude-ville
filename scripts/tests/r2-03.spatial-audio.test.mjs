import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioDirector } from '../../claudeville/src/presentation/shared/audio/AudioDirector.js';
import { CueGovernor } from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';
import { CueKit } from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';
import { bellVoicingForProvider } from '../../claudeville/src/presentation/shared/audio/MusicalScale.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

class FakeNode {
    constructor() {
        this.connections = [];
    }

    connect(node) {
        this.connections.push(node);
        return node;
    }

    disconnect() {}
}

function fakeAudioKit() {
    const panners = [];
    const context = {
        createBiquadFilter() {
            const node = new FakeNode();
            node.frequency = { value: 0 };
            node.Q = { value: 0 };
            return node;
        },
        createStereoPanner() {
            const node = new FakeNode();
            node.pan = { value: 0 };
            panners.push(node);
            return node;
        },
        createOscillator() {
            const node = new FakeNode();
            node.frequency = { value: 0 };
            node.start = () => {};
            node.stop = () => {};
            return node;
        },
        createGain() {
            const node = new FakeNode();
            node.gain = {
                setValueAtTime() {},
                exponentialRampToValueAtTime() {},
            };
            return node;
        },
    };
    const engine = {
        context,
        cueBus: new FakeNode(),
        started: true,
        now: () => 0,
        duck() {},
    };
    const governor = new CueGovernor({ maxPerMinute: 6, minSpacingMs: 0 });
    return { kit: new CueKit(engine, governor), panners };
}

function captureDirectorCalls(world = null) {
    const director = new AudioDirector({
        engine: { context: null, started: false },
        world,
    });
    const calls = [];
    director.cueKit.play = (kind, payload) => {
        calls.push({ kind, payload });
        return true;
    };
    return { director, calls };
}

// Arrival and departure bells belong to a moving body: they wait out the
// current event dispatch so the renderer can declare its accent, then ring on
// it (CueScore.CUE_ACCENT_NOTE). One macrotask drains that wait; the panning
// contract itself is the same voice path for every cue kind.
const nextTick = () => new Promise(resolve => { setTimeout(resolve, 0); });

test('spatial agent cues map normalized screen X to a StereoPanner pan', async () => {
    const left = fakeAudioKit();
    left.kit.play('arrival', { screenX: 0, provider: 'claude' });
    await nextTick();
    assert.equal(left.panners.length, 2);
    assert.ok(left.panners.every(node => node.pan.value === -1));

    const right = fakeAudioKit();
    right.kit.play('distress', { screenX: 1, provider: 'codex' });
    assert.equal(right.panners.length, 1);
    assert.equal(right.panners[0].pan.value, 1);

    const centre = fakeAudioKit();
    centre.kit.play('summons', { provider: 'gemini' });
    assert.equal(centre.panners.length, 2);
    assert.ok(centre.panners.every(node => node.pan.value === 0));
});

test('AudioDirector threads scene position and provider, then centres Dashboard cues', () => {
    const world = {
        agents: new Map([
            ['left-agent', {
                id: 'left-agent',
                provider: 'codex',
                position: { tileX: 2, tileY: 28 },
            }],
        ]),
    };
    const { director, calls } = captureDirectorCalls(world);
    try {
        eventBus.emit('village:scene', {
            kind: 'arrival',
            agentId: 'left-agent',
            screenX: 0.12,
        });
        assert.equal(calls[0].kind, 'arrival');
        assert.equal(calls[0].payload.screenX, 0.12);
        assert.equal(calls[0].payload.provider, 'codex');

        eventBus.emit('mode:changed', 'dashboard');
        eventBus.emit('attention:raised', {
            agentId: 'left-agent',
            agent: { id: 'left-agent', provider: 'codex', screenX: 0.04 },
        });
        assert.equal(calls[1].kind, 'summons');
        assert.equal(calls[1].payload.screenX, 0.5);
    } finally {
        director.destroy();
    }
});

test('tile position is a graceful World-mode screen-X fallback', () => {
    const world = {
        agents: new Map([
            ['left-agent', {
                id: 'left-agent',
                provider: 'gemini',
                position: { tileX: 1, tileY: 30 },
            }],
        ]),
    };
    const { director, calls } = captureDirectorCalls(world);
    try {
        eventBus.emit('village:scene', { kind: 'arrival', agentId: 'left-agent' });
        assert.ok(calls[0].payload.screenX < 0.5);
    } finally {
        director.destroy();
    }
});

test('provider bell voicings are distinct and council bell count follows team size', () => {
    const providers = ['claude', 'codex', 'gemini', 'grok', 'kimi', 'omp', 'opencode', 'deepseek', 'zai'];
    const signatures = providers.map((provider) => JSON.stringify(bellVoicingForProvider(provider)));
    assert.equal(new Set(signatures).size, providers.length);
    assert.notEqual(bellVoicingForProvider('claude').register, bellVoicingForProvider('codex').register);

    const bellCount = (teamSize) => {
        const kit = new CueKit({
            context: {},
            started: true,
            now: () => 0,
            duck() {},
        }, new CueGovernor({ maxPerMinute: 6, minSpacingMs: 0 }));
        const bells = [];
        kit._bell = (...args) => bells.push(args);
        kit.play('council', { teamSize });
        return bells.length;
    };

    assert.deepEqual([bellCount(1), bellCount(3), bellCount(5), bellCount(9)], [2, 3, 5, 5]);
});

test('team:gather forwards its member count without changing governor limits', () => {
    const { director, calls } = captureDirectorCalls();
    try {
        eventBus.emit('team:gather', { teamName: 'alpha', members: ['a', 'b', 'c', 'd'] });
        assert.equal(calls[0].kind, 'council');
        assert.equal(calls[0].payload.teamSize, 4);
        assert.equal(director.governor.maxPerMinute, 6);
        assert.equal(director.governor.minSpacingMs, 4000);
    } finally {
        director.destroy();
    }
});
