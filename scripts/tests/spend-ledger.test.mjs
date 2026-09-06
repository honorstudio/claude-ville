// Spend ledger: today's observed tokens, banked from deltas.
//
// The failure this guards against is a scary wrong number in the most
// prominent slot in the UI — a session's lifetime total dumped into "today",
// or a ten-second burst extrapolated into an alarming hourly rate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SpendLedger } from '../../claudeville/src/application/SpendLedger.js';

const T = 1_700_000_000_000;

function worldOf(agents) {
    return { agents: new Map(agents.map((a) => [a.id, a])) };
}

// `cost` is a getter on the real Agent; a plain field is equivalent here.
function agent(id, { input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cost = 0 } = {}) {
    return { id, tokens: { input, output, cacheRead, cacheCreate }, cost };
}

test('a session first seen mid-flight contributes nothing retroactively', () => {
    const world = worldOf([agent('a', { input: 5_000_000, output: 200_000, cost: 40 })]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);
    assert.equal(ledger.today.tokens, 0);
    assert.equal(ledger.today.cost, 0);
});

test('only growth after the baseline is banked', () => {
    const one = agent('a', { input: 1000, output: 500, cost: 1 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);

    one.tokens = { input: 1400, output: 700, cacheRead: 0, cacheCreate: 0 };
    one.cost = 1.5;
    ledger.sample(T + 1000);

    assert.equal(ledger.today.tokens, 600);
    assert.equal(ledger.today.cost, 0.5);
});

test('cache reads are tracked apart from new tokens', () => {
    // Cache reads re-read the same prompt every turn; counting them as new
    // tokens made the headline an accounting artifact rather than a measure of
    // work done.
    const one = agent('a', { input: 100, cacheRead: 1_000_000 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);

    one.tokens = { input: 200, output: 0, cacheRead: 3_000_000, cacheCreate: 0 };
    ledger.sample(T + 1000);

    assert.equal(ledger.today.tokens, 100);
    assert.equal(ledger.today.cacheRead, 2_000_000);
});

test('a counter that goes backwards re-baselines instead of banking a negative', () => {
    const one = agent('a', { input: 5000, cost: 3 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);

    one.tokens = { input: 100, output: 0, cacheRead: 0, cacheCreate: 0 };
    one.cost = 0.1;
    ledger.sample(T + 1000);
    assert.equal(ledger.today.tokens, 0);
    assert.equal(ledger.today.cost, 0);

    one.tokens = { input: 400, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 2000);
    assert.equal(ledger.today.tokens, 300);
});

test('the burn rate says nothing until the window is wide enough', () => {
    const one = agent('a', { input: 1000 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);

    one.tokens = { input: 2000, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 10_000);
    assert.equal(ledger.burnRate(T + 10_000), null, 'a ten-second burst is not an hourly rate');

    one.tokens = { input: 3000, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 180_000);
    const rate = ledger.burnRate(T + 180_000);
    assert.ok(rate, 'a three-minute window is enough');
    // 2000 new tokens over the 170s between the first and last sample.
    assert.ok(rate.tokensPerHour > 40_000 && rate.tokensPerHour < 45_000, `got ${rate.tokensPerHour}`);
});

test('a new local day starts the ledger over', () => {
    const one = agent('a', { input: 1000 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);
    one.tokens = { input: 2000, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 1000);
    assert.equal(ledger.today.tokens, 1000);

    const tomorrow = new Date(T);
    tomorrow.setDate(tomorrow.getDate() + 1);
    one.tokens = { input: 2500, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(tomorrow.getTime());
    // The rollover clears the day but keeps the baseline, so only the 500
    // tokens spent after midnight land on the new day.
    assert.equal(ledger.today.tokens, 500);
});

test('a departed agent keeps its banked spend but loses its baseline', () => {
    const one = agent('a', { input: 1000 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);
    one.tokens = { input: 3000, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 1000);
    assert.equal(ledger.today.tokens, 2000);

    world.agents.delete('a');
    ledger.sample(T + 2000);
    assert.equal(ledger.today.tokens, 2000, 'spend already observed is not unwound');
});

test('stop drains delayed ledger writes', async () => {
    let releaseWrite;
    const records = [];
    const store = {
        async put(_name, record) {
            await new Promise(resolve => { releaseWrite = resolve; });
            records.push(record);
            return record;
        },
    };
    const one = agent('a', { input: 1000 });
    const ledger = new SpendLedger(worldOf([one]), { store });
    ledger.sample(T);
    one.tokens = { input: 2000, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 1000);
    const stopped = ledger.stop();
    assert.strictEqual(ledger.stop(), stopped);
    let drained = false;
    stopped.then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    releaseWrite();
    await stopped;
    assert.equal(records.length, 1);
    assert.equal(records[0].value.tokens, 1000);
});
