#!/usr/bin/env node

import { loadSpriteManifest } from './manifest-utils.mjs';
import { validateMaterialContract } from './channel-validation.mjs';

const manifest = loadSpriteManifest();
const result = validateMaterialContract(manifest);
console.log(`[channel-validate] errors: ${result.errors}  warnings: ${result.warnings}  expected channel PNGs: ${result.expectedPngPaths.size}`);
process.exit(result.errors ? 1 : 0);
