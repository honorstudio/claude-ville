#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const lockPath = join(repoRoot, 'package-lock.json');
const sourcePackagePath = join(repoRoot, 'node_modules', 'js-yaml', 'package.json');
const sourcePath = join(repoRoot, 'node_modules', 'js-yaml', 'dist', 'js-yaml.min.js');
const vendorPath = join(repoRoot, 'claudeville', 'vendor', 'js-yaml.min.js');

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const lockedVersion = lock.packages?.['node_modules/js-yaml']?.version;
if (!lockedVersion) {
    throw new Error('package-lock.json does not contain node_modules/js-yaml');
}
if (!existsSync(sourcePath)) {
    throw new Error('node_modules/js-yaml/dist/js-yaml.min.js is missing; run npm install before refreshing vendor assets');
}
if (!existsSync(sourcePackagePath)) {
    throw new Error('node_modules/js-yaml/package.json is missing; run npm install before refreshing vendor assets');
}

const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8'));
if (sourcePackage.version !== lockedVersion) {
    throw new Error(`node_modules/js-yaml version ${sourcePackage.version} does not match package-lock version ${lockedVersion}`);
}

copyFileSync(sourcePath, vendorPath);
console.log(`refreshed claudeville/vendor/js-yaml.min.js from js-yaml ${lockedVersion}`);
