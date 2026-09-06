import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { RelationshipState } from '../../claudeville/src/presentation/character-mode/RelationshipState.js';
import {
    inDutyPause,
    IDLE_STRIDE_PERIOD_MS,
    IDLE_STRIDE_PAUSE_FRACTION,
} from '../../claudeville/src/presentation/character-mode/MotionClock.js';

// AgentSprite.js and CouncilRing.js import Canvas/DOM-backed modules, so they
// cannot be loaded in plain Node without inventing a fake DOM. Source-contract
// assertions over the files themselves are the right tool for these
// browser-coupled modules: they prove invented-social-meaning identifiers are
// gone, and that the real pairwise talk path is still present, without a stub.
const CHARACTER_MODE = '../../claudeville/src/presentation/character-mode/';

function readSource(file) {
    return readFileSync(new URL(CHARACTER_MODE + file, import.meta.url), 'utf8');
}

const GOSSIP = /gossip/i;

test('character-mode files contain no gossip identifier', () => {
    const files = {
        'AgentSprite.js': readSource('AgentSprite.js'),
        'CouncilRing.js': readSource('CouncilRing.js'),
        'RelationshipState.js': readSource('RelationshipState.js'),
    };
    for (const [name, source] of Object.entries(files)) {
        assert.doesNotMatch(source, GOSSIP, `${name} still contains a gossip identifier`);
    }
});

test('real pairwise talk identifiers remain in the files that own them', () => {
    const sprite = readSource('AgentSprite.js');
    const ring = readSource('CouncilRing.js');
    const state = readSource('RelationshipState.js');

    assert.match(sprite, /chatPartner/);
    assert.match(sprite, /startChat\s*\(/);
    assert.match(sprite, /endChat\s*\(/);
    assert.match(sprite, /\.chatting\s*=\s*true/);
    // chatting = true is only the self + partner assignment on the SendMessage
    // proximity path; a third assignment would be a new invented talk effect.
    assert.equal((sprite.match(/chatting\s*=\s*true/g) || []).length, 2);

    assert.match(ring, /chatPairs/);
    assert.match(ring, /drawTalkArcs/);
    assert.match(ring, /prioritizedChatPairs/);

    assert.match(state, /chatPairs/);
    assert.match(state, /_rebuildChatPairs/);
});

test('idle stride uses elapsed-ms duty cycle, not update-tick counting', () => {
    const sprite = readSource('AgentSprite.js');
    assert.match(sprite, /_idleStrideMs/);
    assert.match(sprite, /inDutyPause/);
    assert.match(sprite, /IDLE_STRIDE_PERIOD_MS/);
    assert.doesNotMatch(sprite, /_idleStrideTick/);
});

test('two unrelated IDLE agents co-located at one point produce no cluster and no chatting state', () => {
    const agents = new Map([
        ['idle-a', { id: 'idle-a', status: AgentStatus.IDLE }],
        ['idle-b', { id: 'idle-b', status: AgentStatus.IDLE }],
    ]);
    const relationship = new RelationshipState({ agents });
    const sprites = new Map([
        ['idle-a', { agent: agents.get('idle-a'), x: 240, y: 180, chatting: false, chatPartner: null }],
        ['idle-b', { agent: agents.get('idle-b'), x: 240, y: 180, chatting: false, chatPartner: null }],
    ]);

    const snapshot = relationship.update({ agentSprites: sprites, now: 0 });

    assert.ok(snapshot);
    assert.equal('gossipClusters' in snapshot, false);
    assert.equal(snapshot.gossipClusters, undefined);
    assert.deepEqual(snapshot.chatPairs, []);
    assert.equal(sprites.get('idle-a').chatting, false);
    assert.equal(sprites.get('idle-b').chatting, false);
    assert.equal(sprites.get('idle-a').chatPartner, null);
    assert.equal(sprites.get('idle-b').chatPartner, null);
});

function pausedFractionAtHz(hz, durationMs = 2000) {
    const dt = 1000 / hz;
    let paused = 0;
    let samples = 0;
    for (let elapsed = dt; elapsed <= durationMs + 1e-9; elapsed += dt) {
        samples += 1;
        if (inDutyPause(elapsed, IDLE_STRIDE_PERIOD_MS, IDLE_STRIDE_PAUSE_FRACTION)) paused += 1;
    }
    return paused / samples;
}

test('idle stride duty cycle yields the same paused fraction (~0.5) at 30, 60, and 120 Hz', () => {
    const at30 = pausedFractionAtHz(30);
    const at60 = pausedFractionAtHz(60);
    const at120 = pausedFractionAtHz(120);
    for (const [hz, fraction] of [[30, at30], [60, at60], [120, at120]]) {
        assert.ok(Math.abs(fraction - 0.5) < 0.02, `${hz} Hz paused fraction ${fraction}`);
    }
    assert.ok(Math.abs(at30 - at60) < 0.02);
    assert.ok(Math.abs(at120 - at60) < 0.02);
});
