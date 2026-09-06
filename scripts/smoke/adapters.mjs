// Deterministic smoke for the Claude adapter against a synthetic ~/.claude tree.
//
// Strategy: override $HOME before requiring the adapter so its module-level
// CLAUDE_DIR resolves to a temp dir we control. Build the minimum fixture
// (history.jsonl, projects/<encoded>/<id>.jsonl, subagent, sessions/<id>.json,
// teams/<team>/inboxes/<agentName>.json) and assert on getActiveSessions().

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../tests/support/tmp.mjs';

const SCRIPT_NAME = 'adapters.mjs';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ACTIVE_THRESHOLD_MS = 10 * 60 * 1000;
const NOW = Date.now();
const MAIN_SESSION_ID = '11111111-1111-1111-1111-111111111111';
const SUBAGENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_MEMBER_SESSION_ID = '22222222-2222-2222-2222-222222222222';
const PROJECT_MAIN = '/synthetic/project-alpha';
const PROJECT_TEAM = '/synthetic/project-beta';
const TEAM_AGENT_NAME = 'atlas';
const TEAM_NAME = 'squad-alpha';
const WORKFLOW_RUN_ID = 'wf_smoke-001';
const WORKFLOW_NAME = 'doc-corpus-audit';
const WORKFLOW_AGENT_ID = 'bbbbbbbbbbbbbbbbb';

const tmpRoot = makeTempDir('cv-smoke-claude-');
let failed = false;

function pass(message) {
    console.log(`  PASS ${message}`);
}

function fail(message, err) {
    failed = true;
    console.log(`  FAIL ${message}${err ? `: ${err.message || err}` : ''}`);
}

function check(label, fn) {
    try {
        fn();
        pass(label);
    } catch (err) {
        fail(label, err);
    }
}

function writeFile(target, contents) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
}

function encodeProject(project) {
    return project.replace(/\//g, '-');
}

function buildFixture() {
    const claudeDir = path.join(tmpRoot, '.claude');
    const projectsDir = path.join(claudeDir, 'projects');
    const sessionsDir = path.join(claudeDir, 'sessions');
    const teamsDir = path.join(claudeDir, 'teams');

    // history.jsonl: one main session entry within HISTORY_SCAN_MS (10 min).
    const historyEntry = {
        sessionId: MAIN_SESSION_ID,
        project: PROJECT_MAIN,
        timestamp: NOW - 30_000,
        agentType: 'main',
        model: 'claude-sonnet-4-5',
        display: 'synthetic prompt',
    };
    writeFile(path.join(claudeDir, 'history.jsonl'), `${JSON.stringify(historyEntry)}\n`);

    // Parent session .jsonl (empty entries are fine — the adapter only reads).
    const parentDir = path.join(projectsDir, encodeProject(PROJECT_MAIN));
    const parentFile = path.join(parentDir, `${MAIN_SESSION_ID}.jsonl`);
    writeFile(parentFile, '');

    // Subagent under <parent>/subagents/agent-<id>.jsonl.
    const subagentDir = path.join(parentDir, MAIN_SESSION_ID, 'subagents');
    const subagentFile = path.join(subagentDir, `agent-${SUBAGENT_ID}.jsonl`);
    writeFile(subagentFile, '');

    // Workflow sub-agent: nested one level deeper under subagents/workflows/<wfRunId>/,
    // with the run script naming the workflow under <parent>/<id>/workflows/scripts/.
    const workflowAgentFile = path.join(subagentDir, 'workflows', WORKFLOW_RUN_ID, `agent-${WORKFLOW_AGENT_ID}.jsonl`);
    writeFile(workflowAgentFile, '');
    writeFile(
        path.join(parentDir, MAIN_SESSION_ID, 'workflows', 'scripts', `${WORKFLOW_NAME}-${WORKFLOW_RUN_ID}.js`),
        'export const meta = {};\n',
    );

    // Team-member: a .jsonl under a different project dir, with a session
    // metadata file mapping the sessionId to a name that resolves to a team.
    const teamProjectDir = path.join(projectsDir, encodeProject(PROJECT_TEAM));
    const teamMemberFile = path.join(teamProjectDir, `${TEAM_MEMBER_SESSION_ID}.jsonl`);
    writeFile(teamMemberFile, '');

    writeFile(
        path.join(sessionsDir, `${TEAM_MEMBER_SESSION_ID}.json`),
        JSON.stringify({ sessionId: TEAM_MEMBER_SESSION_ID, name: TEAM_AGENT_NAME }),
    );

    writeFile(
        path.join(teamsDir, TEAM_NAME, 'inboxes', `${TEAM_AGENT_NAME}.json`),
        JSON.stringify({ messages: [] }),
    );

    // Touch parent + subagent + team-member files so mtimeMs is fresh.
    const now = new Date(NOW);
    for (const file of [parentFile, subagentFile, workflowAgentFile, teamMemberFile]) {
        fs.utimesSync(file, now, now);
    }

    return { claudeDir };
}

function loadAdapter() {
    // Override HOME so os.homedir() (consulted at module load) points at our
    // fixture. Then use createRequire to import the CJS adapter from this .mjs.
    process.env.HOME = tmpRoot;
    delete process.env.USERPROFILE;
    const require = createRequire(import.meta.url);
    return require(path.join(REPO_ROOT, 'claudeville/adapters/claude.js'));
}

function runSmoke() {
    console.log(`[${SCRIPT_NAME}] fixture: ${tmpRoot}`);
    buildFixture();
    const { ClaudeAdapter } = loadAdapter();
    const adapter = new ClaudeAdapter();

    check('adapter reports availability for fixture HOME', () => {
        assert.equal(adapter.isAvailable(), true);
    });

    const sessions = adapter.getActiveSessions(ACTIVE_THRESHOLD_MS);

    check('getActiveSessions returns an array', () => {
        assert.equal(Array.isArray(sessions), true);
    });

    const main = sessions.find((s) => s.sessionId === MAIN_SESSION_ID);
    check('main session from history.jsonl is present', () => {
        assert.ok(main, 'expected main session in result');
        assert.equal(main.provider, 'claude');
        assert.equal(main.project, PROJECT_MAIN);
    });

    const subagent = sessions.find((s) => s.sessionId === `subagent-${SUBAGENT_ID}`);
    check('subagent appears with parentSessionId linking to main', () => {
        assert.ok(subagent, 'expected subagent session in result');
        assert.equal(subagent.parentSessionId, MAIN_SESSION_ID);
        assert.equal(subagent.agentId, SUBAGENT_ID);
    });

    const workflowAgent = sessions.find((s) => s.sessionId === `subagent-${WORKFLOW_AGENT_ID}`);
    check('workflow sub-agent is discovered with workflow metadata', () => {
        assert.ok(workflowAgent, 'expected nested workflow sub-agent in result');
        assert.equal(workflowAgent.agentType, 'workflow-subagent');
        assert.equal(workflowAgent.parentSessionId, MAIN_SESSION_ID);
        assert.equal(workflowAgent.agentId, WORKFLOW_AGENT_ID);
        assert.equal(workflowAgent.workflowId, WORKFLOW_RUN_ID);
        assert.equal(workflowAgent.workflowName, WORKFLOW_NAME);
    });

    const teamMember = sessions.find((s) => s.sessionId === TEAM_MEMBER_SESSION_ID);
    check('team-member session resolves teamName via teams/<team>/inboxes', () => {
        assert.ok(teamMember, 'expected team-member session in result');
        assert.equal(teamMember.agentName, TEAM_AGENT_NAME);
        assert.equal(teamMember.teamName, TEAM_NAME);
        assert.equal(teamMember.agentType, 'team-member');
    });
}

try {
    runSmoke();
} catch (err) {
    fail('uncaught failure in smoke', err);
} finally {
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (cleanupErr) {
        console.log(`[${SCRIPT_NAME}] cleanup warning: ${cleanupErr.message}`);
    }
}

if (failed) {
    console.log(`[${SCRIPT_NAME}] FAIL`);
    process.exit(1);
}
console.log(`[${SCRIPT_NAME}] PASS`);
