import test from 'node:test';
import assert from 'node:assert/strict';

import {
    constrainSteeringToTarget,
    laneAxisForBridgeOrientation,
} from '../../claudeville/src/presentation/character-mode/MovementSteering.js';

function distanceToTarget(position, target = { x: 10, y: 0 }) {
    return Math.hypot(target.x - position.x, target.y - position.y);
}

test('steering cannot increase distance to the current waypoint', () => {
    const current = { x: 5, y: 0 };
    const steered = constrainSteeringToTarget({
        ...current,
        nextX: 4.2,
        nextY: 0,
        targetX: 10,
        targetY: 0,
    });

    assert.equal(steered.constrained, true);
    assert.ok(distanceToTarget(steered) <= distanceToTarget(current) + 1e-6);
    assert.ok(Math.abs(steered.x - current.x) <= 1e-6);
});

test('progress constraint retains useful lateral separation', () => {
    const current = { x: 5, y: 0 };
    const steered = constrainSteeringToTarget({
        ...current,
        nextX: 5,
        nextY: 1,
        targetX: 10,
        targetY: 0,
    });

    assert.equal(steered.constrained, true);
    assert.ok(steered.y > 0.9, 'the lateral correction should remain visible');
    assert.ok(steered.x > current.x, 'projection should compensate with forward progress');
    assert.ok(distanceToTarget(steered) <= distanceToTarget(current) + 1e-6);
});

test('a slow walker still reaches its waypoint against stronger reverse steering', () => {
    const target = { x: 10, y: 0 };
    let position = { x: 0, y: 0 };
    const forwardStep = 0.5;
    const reverseCorrection = 0.8;

    for (let frame = 0; frame < 24 && distanceToTarget(position, target) > 0; frame++) {
        const distance = distanceToTarget(position, target);
        if (distance <= forwardStep) {
            position = { ...target };
            break;
        }

        position.x += forwardStep;
        position = constrainSteeringToTarget({
            ...position,
            nextX: position.x - reverseCorrection,
            nextY: position.y,
            targetX: target.x,
            targetY: target.y,
        });
    }

    assert.deepEqual(
        { x: position.x, y: position.y },
        target,
        'post-movement steering must not cancel every forward step',
    );
});

test('bridge lane axes follow their authored grid orientation', () => {
    assert.deepEqual(laneAxisForBridgeOrientation('NS'), { dx: 0, dy: 1 });
    assert.deepEqual(laneAxisForBridgeOrientation('EW'), { dx: 1, dy: 0 });
    assert.equal(laneAxisForBridgeOrientation('diagonal'), null);
});
