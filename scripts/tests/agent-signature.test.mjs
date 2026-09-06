import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SIGNATURE_CELLS,
    SIGNATURE_CLASP_COUNT,
    SIGNATURE_COUNT,
    SIGNATURE_TRIM_COUNT,
    agentSignature,
} from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';

const FAMILIES = ['agent.claude.sonnet', 'agent.codex.gpt6astra', 'agent.gemini.base', 'agent.omp.base'];
const IDS = Array.from({ length: 2000 }, (_, i) => `sess-${i}-${(i * 7919) % 977}`);

test('a signature is a pure function of agent id and canonical family', () => {
    for (const family of FAMILIES) {
        for (const id of IDS.slice(0, 40)) {
            const first = agentSignature(id, family);
            const second = agentSignature(id, family);
            assert.equal(first.index, second.index);
            assert.deepEqual(first.rows, second.rows);
            assert.equal(first.key, second.key);
        }
    }
});

test('the signature index space is bounded at four trims by eight clasps', () => {
    assert.equal(SIGNATURE_TRIM_COUNT, 4);
    assert.equal(SIGNATURE_CLASP_COUNT, 8);
    assert.equal(SIGNATURE_COUNT, 32);

    for (const family of FAMILIES) {
        const indices = new Set();
        const shapes = new Set();
        for (const id of IDS) {
            const signature = agentSignature(id, family);
            assert.ok(Number.isInteger(signature.index));
            assert.ok(signature.index >= 0 && signature.index < SIGNATURE_COUNT);
            assert.equal(signature.trim, Math.floor(signature.index / SIGNATURE_CLASP_COUNT));
            assert.equal(signature.clasp, signature.index % SIGNATURE_CLASP_COUNT);
            indices.add(signature.index);
            shapes.add(signature.rows.join('|'));
        }
        // 2000 agents never produce more than the declared 32 marks, and each
        // distinct index maps one-to-one onto a distinct drawn shape.
        assert.ok(indices.size <= SIGNATURE_COUNT);
        assert.equal(indices.size, SIGNATURE_COUNT);
        assert.equal(shapes.size, indices.size);
    }
});

test('distinct families never share a signature identity', () => {
    for (const id of IDS.slice(0, 60)) {
        const keys = new Set(FAMILIES.map(family => agentSignature(id, family).key));
        assert.equal(keys.size, FAMILIES.length);
    }
});

test('every mark is a two-tone 6x6 plate whose trims cut the outline', () => {
    const outlines = new Set();
    for (let index = 0; index < SIGNATURE_COUNT; index++) {
        // Search the id space for one agent per index rather than reaching into
        // the private derivation: the drawn plate is the observable contract.
        const id = IDS.find(candidate => agentSignature(candidate, FAMILIES[0]).index === index);
        assert.ok(id, `no sample id produced signature index ${index}`);
        const signature = agentSignature(id, FAMILIES[0]);
        assert.equal(signature.rows.length, SIGNATURE_CELLS);
        for (const row of signature.rows) {
            assert.equal(row.length, SIGNATURE_CELLS);
            assert.match(row, /^[012]+$/);
        }
        assert.ok(signature.rows.some(row => row.includes('1')), 'clasp accent is always visible');
        outlines.add(signature.rows.map(row => row.replace(/[12]/g, '#')).join('|'));
    }
    assert.equal(outlines.size, SIGNATURE_TRIM_COUNT);
});
