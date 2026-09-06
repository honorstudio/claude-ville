import test from 'node:test';
import assert from 'node:assert/strict';

import { MoodService } from '../../claudeville/src/application/MoodService.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import {
    buildDistrictAtmosphere,
    createAtmosphereSnapshot,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';

function agent(id, projectPath, status = AgentStatus.IDLE) {
    return {
        id,
        projectPath,
        status,
        tokens: { input: 0, output: 0, contextWindow: 0, contextWindowMax: 0 },
        gitEvents: [],
    };
}

test('one failing project among five stays out of the shared sky', () => {
    const service = new MoodService();
    for (let index = 1; index <= 5; index++) {
        service._handleAgentSeen(agent(
            `agent-${index}`,
            `/repos/project-${index}`,
            index === 1 ? AgentStatus.ERRORED : AgentStatus.IDLE,
        ));
    }

    const influence = service.getWeatherInfluence();
    const troubled = influence.districts.find(district => district.project === '/repos/project-1');

    assert.equal(influence.scope, 'district');
    assert.equal(influence.signals.districtCount, 5);
    assert.equal(influence.storminess, 0);
    assert.ok(troubled.storminess > 0);
    assert.deepEqual(troubled.agentIds, ['agent-1']);
    assert.equal(
        influence.districts.filter(district => district.project !== troubled.project)
            .every(district => district.storminess === 0),
        true,
    );
});

test('district trouble becomes feathered ground haze, never a district sky', () => {
    const districts = buildDistrictAtmosphere([{
        project: '/repos/failing',
        agentIds: ['failing-agent'],
        storminess: 0.8,
        clearing: 0,
    }]);

    assert.equal(districts.length, 1);
    assert.ok(districts[0].groundHaze.alpha > 0);
    assert.equal(districts[0].falloff.shape, 'smoothstep');
    assert.ok(districts[0].falloff.outerRadiusTiles > districts[0].falloff.innerRadiusTiles);
    assert.equal('sky' in districts[0], false);
    assert.equal('precipitation' in districts[0], false);
});

test('district metadata does not change the shared weather without consensus', () => {
    const options = {
        now: new Date('2026-08-25T12:00:00'),
        seedOverride: 42,
        timelineMode: 'fixed',
    };
    const baseline = createAtmosphereSnapshot(options);
    const localFailure = createAtmosphereSnapshot({
        ...options,
        eventInfluence: {
            storminess: 0,
            clearing: 0,
            districts: [{
                project: '/repos/failing',
                agentIds: ['failing-agent'],
                storminess: 1,
                clearing: 0,
            }],
        },
    });

    assert.deepEqual(localFailure.weather, baseline.weather);
    assert.deepEqual(localFailure.sky, baseline.sky);
    assert.equal(localFailure.districtAtmosphere.length, 1);
});

test('a legacy one-of-five director roll cannot tint the shared dome', () => {
    const options = {
        now: new Date('2026-08-25T12:00:00'),
        seedOverride: 42,
        timelineMode: 'fixed',
    };
    const baseline = createAtmosphereSnapshot(options);
    const isolatedLegacySignal = createAtmosphereSnapshot({
        ...options,
        eventInfluence: { storminess: 0.1, clearing: 0 },
    });

    assert.deepEqual(isolatedLegacySignal.weather, baseline.weather);
    assert.deepEqual(isolatedLegacySignal.sky, baseline.sky);
});
