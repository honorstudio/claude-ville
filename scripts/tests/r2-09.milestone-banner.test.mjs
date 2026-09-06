import test from 'node:test';
import assert from 'node:assert/strict';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import { VillageDirector } from '../../claudeville/src/presentation/character-mode/VillageDirector.js';

function makeWorld(agent = null) {
    return {
        agents: new Map(agent ? [[agent.id, agent]] : []),
        buildings: new Map(),
    };
}

function incident(index, now) {
    return {
        id: `incident-${index}`,
        type: 'incident',
        kind: `error-${index}`,
        startedAt: now,
        expiresAt: now + 10_000,
    };
}

test('biography classifies first-earned rewards and never earns them twice', () => {
    const biography = AgentBiography.create('villager:codex:ada', 1);
    biography.sessionsCompleted = 9;

    const earned = biography.recordSessionCompleted(2);
    assert.deepEqual(earned.map(entry => [entry.id, entry.kind]), [
        ['sessionsCompleted-1', 'milestone'],
        ['sessionsCompleted-10', 'milestone'],
    ]);
    assert.deepEqual(biography._collectNewMilestones(3), []);

    const restored = AgentBiography.fromRecord({
        ...biography.toRecord(),
        milestones: [{ id: 'legacy-nickname', nickname: 'the Tester', label: 'Legacy title' }],
    });
    assert.equal(restored.milestones[0].kind, 'nickname');
});

test('simultaneous earned rewards stage one restrained banner and repeats do not re-fire', () => {
    const agent = { id: 'agent-1', provider: 'codex', name: 'Ada', buildingType: 'forge' };
    const identityKey = AgentBiography.identityKeyFor(agent);
    const director = new VillageDirector(makeWorld(agent));
    const milestones = [
        { id: 'errorsRecovered-10', kind: 'milestone', label: '10 errors overcome' },
        { id: 'nickname-errorsRecovered-10', kind: 'nickname', label: 'Earned a nickname', nickname: 'the Debugger' },
    ];

    eventBus.emit('biography:updated', { identityKey, milestones });
    const first = director.update(null, 16, 1_000);
    assert.equal(first.releaseParade?.kind, 'biography-banner');
    assert.equal(first.releaseParade?.label, 'Ada · the Debugger');
    assert.deepEqual(first.releaseParade?.milestoneIds, milestones.map(entry => entry.id));

    eventBus.emit('biography:updated', { identityKey, milestones });
    director.update(null, 16, 11_000);
    assert.equal(director.scenes.filter(scene => scene.kind === 'biography-banner').length, 0);
    assert.equal(director._pendingBiographyBanners.length, 0);
    director.dispose();
});

test('banner waits behind a full budget and incidents displace celebrations first', () => {
    const agent = { id: 'agent-2', provider: 'codex', name: 'Grace' };
    const identityKey = AgentBiography.identityKeyFor(agent);
    const director = new VillageDirector(makeWorld(agent));
    const now = Date.now();
    for (let index = 0; index < 8; index++) director._addScene(incident(index, now));

    eventBus.emit('biography:updated', {
        identityKey,
        milestones: [{ id: 'commitsPushed-10', kind: 'milestone', label: '10 pushes to the harbor' }],
    });
    director.update(null, 16, now);
    assert.equal(director.scenes.filter(scene => scene.type === 'incident').length, 8);
    assert.equal(director._pendingBiographyBanners.length, 1);

    director.update(null, 16, now + 10_001);
    assert.equal(director.scenes.filter(scene => scene.kind === 'biography-banner').length, 1);
    for (let index = 0; index < 8; index++) director._addScene(incident(index + 8, now + 10_001));
    assert.equal(director.scenes.filter(scene => scene.type === 'incident').length, 8);
    assert.equal(director.scenes.some(scene => scene.kind === 'biography-banner'), false);
    assert.equal(director._sceneOverflowSummary(now + 10_001)?.label, '+1 more moment');
    director.dispose();
});
