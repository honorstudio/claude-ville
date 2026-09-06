import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RelationshipAffinityService,
    affinityWarmthPhase,
} from '../../claudeville/src/application/RelationshipAffinityService.js';
import { PairAffinity, AFFINITY_HALF_LIFE_MS } from '../../claudeville/src/domain/value-objects/PairAffinity.js';
import { relationshipLoreLine } from '../../claudeville/src/presentation/shared/ActivityPanel.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 25, 12);

function affinityFor(identityA, identityB, {
    meetings = 0,
    chats = 0,
    sharedCommits = 0,
    score = 0,
    age = 0,
} = {}) {
    return new PairAffinity({
        pairKey: [identityA, identityB].sort().join('|'),
        meetings,
        chats,
        sharedCommits,
        score,
        firstMetAt: NOW - age,
        lastInteractionAt: NOW - age,
        scoreUpdatedAt: NOW - age,
    });
}

test('warmth phases communicate the 48-hour decay clock without a raw score', () => {
    const bond = affinityFor('named:codex:ada', 'named:claude:bea', { meetings: 1, score: 3 });
    assert.equal(affinityWarmthPhase(bond, bond.scoreUpdatedAt + 6 * HOUR), 'hearth-warm');
    assert.equal(affinityWarmthPhase(bond, bond.scoreUpdatedAt + 24 * HOUR), 'warm');
    assert.equal(affinityWarmthPhase(bond, bond.scoreUpdatedAt + AFFINITY_HALF_LIFE_MS), 'cooling');
    assert.equal(affinityWarmthPhase(bond, bond.scoreUpdatedAt + 2 * AFFINITY_HALF_LIFE_MS), 'faint');
});

test('collaborators include cooled history, rank current tiers, and preserve exact commit totals', () => {
    const selected = 'named:codex:ada';
    const service = new RelationshipAffinityService();
    const ally = affinityFor(selected, 'named:claude:bea', {
        meetings: 3,
        chats: 4,
        sharedCommits: 40,
        score: 8,
        age: 6 * HOUR,
    });
    const stranger = affinityFor(selected, 'named:gemini:cy', {
        meetings: 1,
        sharedCommits: 12,
        score: 2,
        age: 8 * 24 * HOUR,
    });
    const baselineOnly = affinityFor(selected, 'named:grok:dee');
    service._affinities.set(ally.pairKey, ally);
    service._affinities.set(stranger.pairKey, stranger);
    service._affinities.set(baselineOnly.pairKey, baselineOnly);

    const collaborators = service.collaboratorsFor(selected, NOW);
    assert.deepEqual(collaborators.map(entry => entry.identityKey), [
        'named:claude:bea',
        'named:gemini:cy',
    ]);
    assert.equal(collaborators[0].tier, 'allies');
    assert.equal(collaborators[0].sharedCommits, 40);
    assert.equal(collaborators[1].tier, 'strangers');
    assert.equal(collaborators[1].warmth, 'faint');
});

test('relationship lore is compact, factual, and handles zero shared commits', () => {
    assert.equal(relationshipLoreLine({
        warmth: 'hearth-warm',
        sharedCommits: 40,
        lastInteractionAt: NOW - 3 * HOUR,
    }, NOW), 'Hearth-warm · 40 shared commits · crossed paths 3h ago');
    assert.equal(relationshipLoreLine({
        warmth: 'cooling',
        sharedCommits: 0,
        lastInteractionAt: NOW - 2 * 24 * HOUR,
    }, NOW), 'Cooling trail · 0 shared commits · crossed paths 2d ago');
});
