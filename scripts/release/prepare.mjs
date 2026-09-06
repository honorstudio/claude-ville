#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractReleaseSection, parseReleaseHeader } from './changelog.mjs';

const HELP = `Usage:
  node scripts/release/prepare.mjs <version> [--write] [--tag]
  node scripts/release/prepare.mjs --verify

The top CHANGELOG entry must use exactly one of:
  ## v0.X.Y — *Release Name* · Mon DD, YYYY
  ## v0.X.Y.Z · Mon DD, YYYY — Hotfix

Dry-run is the default. It validates the top entry, previews both version edits,
prints the release notes and exact gh command, and changes no files.

  --write   Write package.json, claudeville/index.html, and the notes temp file.
  --tag     With a clean worktree, create an annotated local tag at HEAD.
            It never pushes and never invokes gh. Cannot be combined with --write.
  --verify  With no version argument, verify package.json and the UI version agree
            with the top CHANGELOG entry. Suitable for a no-argument release gate.

The UI displays v<major>.<minor>; package.json stores the full release version.`;

function fail(message) {
    throw new Error(message);
}

function parseVersion(version) {
    const match = version?.match(/^(0)\.(\d+)\.(\d+)(?:\.(\d+))?$/);
    if (!match) fail(`Invalid version "${version ?? ''}"; expected 0.X.Y or 0.X.Y.Z.`);
    return {
        value: version,
        parts: match.slice(1).filter((part) => part !== undefined),
        ui: `v${match[1]}.${match[2]}`,
    };
}

function topRelease(changelog) {
    const header = changelog.match(/^## [^\r\n]*$/m);
    if (!header) fail('CHANGELOG.md has no release header.');
    const parsed = parseReleaseHeader(header[0]);
    if (!parsed) fail(`Malformed top CHANGELOG header: ${header[0]}`);
    if (parsed.hasDateRange) {
        fail('The top CHANGELOG header must use a single date, not a date range.');
    }
    if (!/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:0[1-9]|[12]\d|3[01]), \d{4}$/.test(parsed.date)) {
        fail('The top CHANGELOG header date must use Mon DD, YYYY.');
    }
    const componentCount = parsed.version.split('.').length;
    if (parsed.type === 'named' && componentCount !== 3) {
        fail('A named release version must have the form 0.X.Y.');
    }
    if (parsed.type === 'hotfix' && componentCount !== 4) {
        fail('A hotfix version must have the form 0.X.Y.Z.');
    }
    return parsed;
}

function replacePackageVersion(text, version) {
    const pattern = /^([ \t]*"version"[ \t]*:[ \t]*")([^"]+)(",?[ \t]*)$/m;
    const matches = text.match(pattern);
    if (!matches) fail('Could not find the package.json version field.');
    return {
        before: matches[0],
        after: `${matches[1]}${version}${matches[3]}`,
        text: text.replace(pattern, `${matches[1]}${version}${matches[3]}`),
    };
}

function replaceUiVersion(text, uiVersion) {
    const pattern = /^([ \t]*<span class="topbar__version"[^>]*>)([^<]+)(<\/span>[ \t]*)$/m;
    const matches = text.match(pattern);
    if (!matches) fail('Could not find claudeville/index.html .topbar__version text.');
    return {
        before: matches[0],
        after: `${matches[1]}${uiVersion}${matches[3]}`,
        text: text.replace(pattern, `${matches[1]}${uiVersion}${matches[3]}`),
    };
}

function printDiff(path, change, output) {
    output(`--- a/${path}`);
    output(`+++ b/${path}`);
    output('@@ version @@');
    output(`-${change.before}`);
    output(`+${change.after}`);
}

export function inspectRelease(root, requestedVersion, notesDirectory = tmpdir()) {
    const version = parseVersion(requestedVersion);
    const changelogPath = join(root, 'CHANGELOG.md');
    const packagePath = join(root, 'package.json');
    const indexPath = join(root, 'claudeville/index.html');
    const changelog = readFileSync(changelogPath, 'utf8');
    const release = topRelease(changelog);
    if (release.version !== version.value) {
        fail(`Top CHANGELOG version is ${release.version}, not ${version.value}.`);
    }

    const notes = extractReleaseSection(changelog, version.value);
    if (notes === null) fail(`Could not extract CHANGELOG section for ${version.value}.`);
    const packageText = readFileSync(packagePath, 'utf8');
    const indexText = readFileSync(indexPath, 'utf8');

    return {
        release,
        version,
        notes,
        notesPath: join(notesDirectory, `claudeville-release-v${version.value}.md`),
        packagePath,
        indexPath,
        packageChange: replacePackageVersion(packageText, version.value),
        indexChange: replaceUiVersion(indexText, version.ui),
    };
}

export function verifyRelease(root) {
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const release = topRelease(changelog);
    const inspected = inspectRelease(root, release.version);
    if (inspected.packageChange.before !== inspected.packageChange.after) {
        fail(`package.json does not match top CHANGELOG version ${release.version}.`);
    }
    if (inspected.indexChange.before !== inspected.indexChange.after) {
        fail(`claudeville/index.html does not match UI version ${inspected.version.ui}.`);
    }
    return inspected;
}

export function prepareRelease(root, requestedVersion, {
    write = false,
    notesDirectory = tmpdir(),
} = {}) {
    const inspected = inspectRelease(root, requestedVersion, notesDirectory);
    if (write) {
        writeFileSync(inspected.packagePath, inspected.packageChange.text);
        writeFileSync(inspected.indexPath, inspected.indexChange.text);
        writeFileSync(inspected.notesPath, inspected.notes);
    }
    return inspected;
}

function parseArgs(args) {
    if (args.includes('--help') || args.includes('-h')) return { help: true };
    const known = new Set(['--write', '--tag', '--verify']);
    const unknown = args.filter((arg) => arg.startsWith('-') && !known.has(arg));
    if (unknown.length) fail(`Unknown option: ${unknown[0]}`);
    const positional = args.filter((arg) => !arg.startsWith('-'));
    const verify = args.includes('--verify');
    const write = args.includes('--write');
    const tag = args.includes('--tag');
    if (verify && (positional.length || write || tag)) {
        fail('--verify takes no version and cannot be combined with --write or --tag.');
    }
    if (!verify && positional.length !== 1) fail('Provide exactly one release version.');
    if (write && tag) fail('--write and --tag must be separate steps.');
    return { version: positional[0], verify, write, tag };
}

function createTag(root, inspected) {
    const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
    });
    if (status !== '') fail('Cannot tag: git status --porcelain is not empty.');
    const tag = `v${inspected.version.value}`;
    const title = inspected.release.type === 'hotfix'
        ? `${tag} - Hotfix`
        : `${tag} - ${inspected.release.name}`;
    execFileSync('git', ['tag', '-a', tag, '-m', title, 'HEAD'], {
        cwd: root,
        stdio: 'inherit',
    });
    return tag;
}

function releaseCommand(inspected) {
    const tag = `v${inspected.version.value}`;
    const title = inspected.release.type === 'hotfix'
        ? `${tag} - Hotfix`
        : `${tag} - ${inspected.release.name}`;
    return `gh release create ${tag} --title "${title}" --notes-file ${inspected.notesPath}`;
}

export function main(args = process.argv.slice(2), root = process.cwd(), output = console.log) {
    const options = parseArgs(args);
    if (options.help) {
        output(HELP);
        return;
    }
    if (options.verify) {
        const inspected = verifyRelease(root);
        output(`Validation passed: CHANGELOG.md, package.json, and UI agree on v${inspected.version.value} (${inspected.version.ui}).`);
        output('Reminder: update the "As of" header in agents/plans/open-followups.md.');
        return;
    }

    const inspected = prepareRelease(root, options.version, { write: options.write });
    output(`Validation passed: top CHANGELOG entry is v${inspected.version.value} (${inspected.release.type}).`);
    printDiff('package.json', inspected.packageChange, output);
    printDiff('claudeville/index.html', inspected.indexChange, output);
    output('');
    output('Release notes:');
    output(inspected.notes.replace(/\n$/, ''));
    output('');
    output(releaseCommand(inspected));
    if (options.write) output(`Wrote version files and ${inspected.notesPath}.`);
    if (options.tag) output(`Created annotated local tag ${createTag(root, inspected)} at HEAD.`);
    output('Reminder: update the "As of" header in agents/plans/open-followups.md.');
}

const isMain = process.argv[1]
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        main();
    } catch (error) {
        console.error(`release prepare: ${error.message}`);
        process.exitCode = 1;
    }
}
