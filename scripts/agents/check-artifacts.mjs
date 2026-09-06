#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const agentsRoot = path.join(repoRoot, 'agents');
const indexPath = path.join(agentsRoot, 'README.md');
const problems = [];

function report(message) {
  problems.push(message);
}

async function exists(target, kind) {
  try {
    const details = await stat(target);
    return kind === 'directory' ? details.isDirectory() : details.isFile();
  } catch {
    return false;
  }
}

function statusFrom(markdown, label) {
  const match = markdown.match(/^\*\*Status:\*\*\s+`([^`]+)`(?:\s+.*)?$/m);
  if (!match) {
    report(`${label}: add a first metadata line in the form **Status:** \`<status>\`.`);
    return null;
  }
  return match[1];
}

async function inventory(directory, { directories = false } = {}) {
  let entries;
  try {
    entries = await readdir(path.join(agentsRoot, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => directories ? entry.isDirectory() : entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

const index = await readFile(indexPath, 'utf8');
const rows = [];
for (const line of index.split('\n')) {
  if (!line.startsWith('|')) continue;
  const match = line.match(/^\|\s*\[`[^`]+`\]\(([^)]+)\)\s*\|\s*`([^`]+)`\s*\|/);
  if (match) rows.push({ target: match[1], status: match[2] });
}

const expected = [
  ...(await inventory('plans')),
  ...(await inventory('research', { directories: true })).map((target) => `${target}/`),
  ...(await inventory('handover')),
];

for (const target of expected) {
  const matches = rows.filter((row) => row.target === target);
  if (matches.length === 0) report(`agents/README.md: add exactly one inventory row linking to ${target}.`);
  if (matches.length > 1) report(`agents/README.md: remove duplicate inventory rows for ${target}.`);
}

for (const row of rows) {
  if (!/^(plans\/[^/]+\.md|research\/[^/]+\/|handover\/[^/]+\.md)$/.test(row.target)) {
    report(`agents/README.md: inventory link ${row.target} must target a plan file, research directory, or handover file.`);
    continue;
  }
  const kind = row.target.startsWith('research/') ? 'directory' : 'file';
  const absolute = path.join(agentsRoot, row.target);
  if (!(await exists(absolute, kind))) {
    report(`agents/README.md: linked ${kind} ${row.target} does not exist.`);
    continue;
  }

  let statusFile = absolute;
  if (kind === 'directory') {
    statusFile = path.join(absolute, 'README.md');
    if (!(await exists(statusFile, 'file'))) continue;
  }
  const artifact = await readFile(statusFile, 'utf8');
  const artifactStatus = statusFrom(artifact, path.relative(repoRoot, statusFile));
  if (artifactStatus !== null && artifactStatus !== row.status) {
    report(`agents/README.md: change ${row.target} status to \`${artifactStatus}\` to match the artifact.`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log(`Artifact index is consistent (${expected.length} retained artifacts).`);
}
