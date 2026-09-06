import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentSearchIndex } from '../../claudeville/src/presentation/shared/SearchIndex.js';

function agent(id, overrides = {}) {
    return {
        id,
        name: id,
        model: 'claude-opus',
        status: 'working',
        provider: 'claude',
        projectPath: '/work/project',
        gitEvents: [],
        ...overrides,
    };
}

test('indexes existing identity fields and resident tool activity', () => {
    const index = new AgentSearchIndex();
    index.upsert(agent('ada', {
        name: 'Ada',
        status: 'waiting_on_user',
        currentTool: 'Read',
    }), { modelLabel: 'Opus' });

    assert.equal(index.search('ada')[0].agentId, 'ada');
    assert.equal(index.search('opus')[0].agentId, 'ada');
    assert.equal(index.search('waiting_on')[0].agentId, 'ada');
    assert.equal(index.search('read')[0].context, 'Tool · Read');
});

test('indexes file paths from live inputs and cached tool history', () => {
    const index = new AgentSearchIndex();
    const session = agent('builder', {
        currentTool: 'apply_patch',
        currentToolInput: { file_path: '/work/project/src/Sidebar.js' },
    });
    index.upsert(session, {
        detail: {
            toolHistory: [
                { tool: 'exec_command', detail: 'node scripts/tests/search-index.test.mjs' },
                { tool: 'Write', input: { path: 'docs/search notes.md' } },
            ],
        },
    });

    assert.equal(index.search('sidebar.js')[0].context, 'File · /work/project/src/Sidebar.js');
    assert.equal(index.search('search-index.test.mjs')[0].agentId, 'builder');
    assert.equal(index.search('search notes.md')[0].agentId, 'builder');
    assert.equal(index.search('exec_command')[0].context, 'Tool · exec_command');
});

test('indexes commit subjects and messages embedded in commit commands', () => {
    const index = new AgentSearchIndex();
    index.upsert(agent('shipper', {
        gitEvents: [
            { type: 'commit', label: 'Add searchable village history' },
            { type: 'commit', command: 'git commit -m "Fix harbor counter"' },
            { type: 'push', commits: [{ subject: 'Ship nested commit record' }] },
        ],
    }));

    assert.equal(index.search('searchable village')[0].context, 'Commit · Add searchable village history');
    assert.equal(index.search('harbor counter')[0].agentId, 'shipper');
    assert.equal(index.search('nested commit')[0].agentId, 'shipper');
});

test('ranks direct identity matches ahead of tool, file, and commit matches', () => {
    const index = new AgentSearchIndex();
    index.upsert(agent('name-match', { name: 'Needle' }));
    index.upsert(agent('tool-match', { currentTool: 'Needle' }));
    index.upsert(agent('file-match', { currentToolInput: { path: 'src/needle.js' } }));
    index.upsert(agent('commit-match', { gitEvents: [{ label: 'Needle cleanup' }] }));

    assert.deepEqual(index.search('needle').map(result => result.agentId), [
        'name-match',
        'tool-match',
        'file-match',
        'commit-match',
    ]);
});

test('adds lazy detail incrementally and retains it without repeated rebuilding', () => {
    const index = new AgentSearchIndex();
    const session = agent('lazy', { currentTool: 'Read' });
    assert.equal(index.upsert(session), true);
    const liveRevision = index.revision;
    assert.equal(index.search('historical-tool').length, 0);
    assert.equal(index.upsert(session), false);
    assert.equal(index.revision, liveRevision);

    assert.equal(index.upsert(session, {
        detail: { toolHistory: [{ tool: 'historical-tool', detail: 'src/archive.js' }] },
    }), true);
    assert.equal(index.search('historical-tool')[0].agentId, 'lazy');
    const detailRevision = index.revision;

    assert.equal(index.upsert(session), false);
    assert.equal(index.revision, detailRevision);
    assert.equal(index.search('archive.js')[0].agentId, 'lazy');
    assert.equal(index.remove('lazy'), true);
    assert.equal(index.search('read').length, 0);
});


test('searches CLI identity independently of model vendor, project, team, workflow and session', () => {
    const index = new AgentSearchIndex();
    index.upsert(agent('session-123', { name: 'Aria', provider: 'opencode', model: 'gpt-6-astra', projectPath: '/repo/checkout', teamName: 'Night Watch', workflowName: 'ship-release' }));
    index.upsert(agent('session-456', { provider: 'omp', model: 'glm-5', projectPath: '/repo/library' }));
    for (const query of ['opencode', 'gpt-6-astra', 'checkout', 'Night Watch', 'ship-release', 'session-123']) {
        assert.equal(index.search(query)[0]?.agentId, 'session-123', query);
    }
    for (const query of ['omp', 'glm-5', 'library']) assert.equal(index.search(query)[0]?.agentId, 'session-456', query);
    assert.equal(index.search('claude').length, 0);
});
