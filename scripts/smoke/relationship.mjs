// Deterministic smoke for RelationshipState against a stub World.
//
// Exercises the parent/child + team membership snapshot, and confirms that
// the membership cache does not reallocate when _membershipDirty is false
// (snapshot.teamToMembers and its inner Array references must be preserved
// across non-dirty update() calls).

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_NAME = 'relationship.mjs';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RELATIONSHIP_PATH = path.join(
    REPO_ROOT,
    'claudeville/src/presentation/character-mode/RelationshipState.js',
);
const EVENT_BUS_PATH = path.join(
    REPO_ROOT,
    'claudeville/src/domain/events/DomainEvent.js',
);

let failed = false;

function pass(message) { console.log(`  PASS ${message}`); }
function fail(message, err) {
    failed = true;
    console.log(`  FAIL ${message}${err ? `: ${err.message || err}` : ''}`);
}
function check(label, fn) {
    try { fn(); pass(label); } catch (err) { fail(label, err); }
}

const PARENT_ID = 'session-parent';
const SUB1_ID = 'session-sub-1';
const SUB2_ID = 'session-sub-2';
const SUB3_ID = 'session-sub-3';
const TEAM_MEMBER_ID = 'session-team-member';
const TEAM_NAME = 'squad-alpha';

function makeAgent({ id, parentSessionId = null, teamName = null }) {
    return {
        id,
        name: id,
        provider: 'claude',
        parentSessionId,
        teamName,
        position: { x: 0, y: 0 },
    };
}

function makeStubWorld() {
    // RelationshipState only reads world.agents.values() — a plain object with
    // a Map works. Real World would emit agent:added itself; we emit manually
    // so the listeners flip _membershipDirty for each agent.
    return { agents: new Map() };
}

async function runSmoke() {
    const { RelationshipState } = await import(pathToFileURL(RELATIONSHIP_PATH).href);
    const { eventBus } = await import(pathToFileURL(EVENT_BUS_PATH).href);

    const world = makeStubWorld();
    const agents = [
        makeAgent({ id: PARENT_ID }),
        makeAgent({ id: SUB1_ID, parentSessionId: PARENT_ID }),
        makeAgent({ id: SUB2_ID, parentSessionId: PARENT_ID }),
        makeAgent({ id: SUB3_ID, parentSessionId: PARENT_ID }),
        makeAgent({ id: TEAM_MEMBER_ID, teamName: TEAM_NAME }),
    ];

    const relationship = new RelationshipState(world);
    try {
        for (const agent of agents) {
            world.agents.set(agent.id, agent);
            eventBus.emit('agent:added', agent);
        }

        const snapshot1 = relationship.update();

        check('parentToChildren maps the parent to 3 subagent ids', () => {
            const children = snapshot1.parentToChildren.get(PARENT_ID);
            assert.ok(children instanceof Set, 'expected Set of children');
            assert.equal(children.size, 3);
            assert.equal(children.has(SUB1_ID), true);
            assert.equal(children.has(SUB2_ID), true);
            assert.equal(children.has(SUB3_ID), true);
        });

        check('childToParent inverts the parent->children mapping', () => {
            assert.equal(snapshot1.childToParent.get(SUB1_ID), PARENT_ID);
            assert.equal(snapshot1.childToParent.get(SUB2_ID), PARENT_ID);
            assert.equal(snapshot1.childToParent.get(SUB3_ID), PARENT_ID);
            assert.equal(snapshot1.childToParent.has(PARENT_ID), false);
            assert.equal(snapshot1.childToParent.has(TEAM_MEMBER_ID), false);
        });

        check('teamToMembers resolves the team to its member id', () => {
            const members = snapshot1.teamToMembers.get(TEAM_NAME);
            assert.ok(Array.isArray(members), 'snapshot teamToMembers values are arrays');
            assert.deepEqual(members, [TEAM_MEMBER_ID]);
        });

        // Cache behavior: with _membershipDirty=false, _rebuildMembership must
        // NOT run, so the teamToMembers Map and its inner Array references
        // must be the same instances on the next non-dirty update().
        const teamArrayBefore = snapshot1.teamToMembers.get(TEAM_NAME);
        const teamMapBefore = snapshot1.teamToMembers;
        const parentSetBefore = snapshot1.parentToChildren.get(PARENT_ID);

        const snapshot2 = relationship.update();

        check('membership cache: teamToMembers Map instance is preserved when not dirty', () => {
            assert.strictEqual(snapshot2.teamToMembers, teamMapBefore);
        });

        check('membership cache: inner team array reference is preserved when not dirty', () => {
            assert.strictEqual(snapshot2.teamToMembers.get(TEAM_NAME), teamArrayBefore);
        });

        check('membership cache: parentToChildren Set reference is preserved when not dirty', () => {
            assert.strictEqual(snapshot2.parentToChildren.get(PARENT_ID), parentSetBefore);
        });

        check('membership cache: marking dirty rebuilds the inner team array', () => {
            // Force dirty by emitting agent:updated with no change — only
            // membership-shaped diffs flip _membershipDirty, so we trigger
            // a real rebuild via agent:added of a fresh agent that doesn't
            // belong to any team. parentToChildren stays unchanged, but
            // _rebuildMembership recreates the cached arrays.
            const extra = makeAgent({ id: 'session-extra' });
            world.agents.set(extra.id, extra);
            eventBus.emit('agent:added', extra);
            const snapshot3 = relationship.update();
            const teamArrayAfter = snapshot3.teamToMembers.get(TEAM_NAME);
            assert.deepEqual(teamArrayAfter, [TEAM_MEMBER_ID]);
            assert.notStrictEqual(teamArrayAfter, teamArrayBefore);
        });
    } finally {
        relationship.dispose();
    }
}

try {
    await runSmoke();
} catch (err) {
    fail('uncaught failure in smoke', err);
}

if (failed) {
    console.log(`[${SCRIPT_NAME}] FAIL`);
    process.exit(1);
}
console.log(`[${SCRIPT_NAME}] PASS`);
