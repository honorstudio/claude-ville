'use strict';

// Keep collision work bounded even if a provider starts returning a much
// larger working set than the F3 contract permits.
const MAX_WORKING_SET_ITEMS = 16;
const MAX_COLLISIONS_PER_PROJECT = 32;
const MAX_AGENTS_PER_COLLISION = 16;
const DEPARTED_GRACE_MS = 10 * 60 * 1000;
// 4.5 — two observations of the same path count as concurrent evidence only
// when the adapters saw them within a minute of each other. Anything wider is
// still real overlap, but it is *recent* overlap, not simultaneous work.
const CONCURRENT_WINDOW_MS = 60 * 1000;

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sessionId(session) {
  const value = session?.sessionId ?? session?.id ?? session?.agentId;
  return value === null || value === undefined ? '' : String(value);
}

function sessionProject(session) {
  const value = session?.project ?? session?.projectPath;
  const project = value === null || value === undefined ? '' : String(value).trim();
  return project && project !== '_unknown' ? project : '';
}

function isWithinDepartedGrace(session, now) {
  const ended = session?.turnState === 'awaiting_input'
    || session?.status === 'completed'
    || finiteTimestamp(session?.departedAt) !== null;
  if (!ended) return true;
  const endedAt = finiteTimestamp(session?.departedAt)
    || finiteTimestamp(session?.lastActivity)
    || finiteTimestamp(session?.lastSessionActivity);
  return endedAt !== null && now - endedAt <= DEPARTED_GRACE_MS;
}

function normalizedWorkingSet(session) {
  if (!Array.isArray(session?.workingSet)) return [];
  const byPath = new Map();
  for (const item of session.workingSet.slice(0, MAX_WORKING_SET_ITEMS)) {
    const path = typeof item?.path === 'string' ? item.path.trim() : '';
    const op = item?.op === 'write' ? 'write' : (item?.op === 'read' ? 'read' : null);
    if (!path || !op || path.includes('\0')) continue;
    const at = finiteTimestamp(item?.at);
    const previous = byPath.get(path);
    // One agent writing a path dominates its own read of that path; among
    // entries of the same op the newest observation wins, so an edge carries
    // the latest time this agent was actually seen on the path.
    if (!previous || (op === 'write' && previous.op !== 'write')) {
      byPath.set(path, { op, at });
    } else if (previous.op === op && at !== null && (previous.at === null || at > previous.at)) {
      byPath.set(path, { op, at });
    }
  }
  return byPath;
}

/**
 * Find exact canonical-path overlaps inside each project.
 *
 * Adapters own realpath/canonicalisation. This pure service deliberately does
 * not resolve paths again: a symlink which canonicalised outside a project is
 * represented by its external path and therefore cannot equal the in-project
 * relative path.
 */
function detectCollisions(sessions, now = Date.now()) {
  const projects = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const id = sessionId(session);
    const project = sessionProject(session);
    if (!id || !project || !isWithinDepartedGrace(session, now)) continue;
    const workingSet = normalizedWorkingSet(session);
    if (!workingSet.size) continue;
    if (!projects.has(project)) projects.set(project, new Map());
    const paths = projects.get(project);
    for (const [path, observation] of workingSet) {
      if (!paths.has(path)) paths.set(path, new Map());
      paths.get(path).set(id, observation);
    }
  }

  const collisions = [];
  for (const project of [...projects.keys()].sort()) {
    let projectCount = 0;
    const paths = projects.get(project);
    for (const path of [...paths.keys()].sort()) {
      const operations = paths.get(path);
      if (operations.size < 2) continue;
      const agents = [...operations.keys()].sort().slice(0, MAX_AGENTS_PER_COLLISION);
      const observations = agents.map(id => ({
        agentId: id,
        op: operations.get(id).op,
        at: operations.get(id).at,
      }));
      const writeCount = observations.filter(entry => entry.op === 'write').length;
      // Read/read is intentionally silent. A single writer plus readers is a
      // muted advisory; two or more writers is the loud collision.
      if (writeCount === 0) continue;
      const times = observations.map(entry => entry.at);
      const dated = times.every(at => at !== null);
      collisions.push({
        path,
        project,
        agents,
        kind: writeCount >= 2 ? 'write-write' : 'read-write',
        // Overlap is always real; simultaneity is only claimed when every
        // participant carries a time and those times sit inside one minute.
        overlapKind: dated && Math.max(...times) - Math.min(...times) <= CONCURRENT_WINDOW_MS
          ? 'concurrent'
          : 'recent',
        observations,
      });
      projectCount++;
      if (projectCount >= MAX_COLLISIONS_PER_PROJECT) break;
    }
  }
  return collisions;
}

module.exports = {
  CONCURRENT_WINDOW_MS,
  DEPARTED_GRACE_MS,
  MAX_COLLISIONS_PER_PROJECT,
  detectCollisions,
};
