import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'claudeville/src/config/models.json');
const TEMPLATE_PATH = path.join(SCRIPT_DIR, 'resolver.template.js');
const OUTPUTS = [
    { path: path.join(REPO_ROOT, 'claudeville/src/config/models.generated.js'), format: 'esm' },
    { path: path.join(REPO_ROOT, 'claudeville/src/config/models.generated.cjs'), format: 'cjs' },
];
const HEADER = '// GENERATED FROM models.json + scripts/models/resolver.template.js — DO NOT EDIT';
const EXPORTS = [
    'MODEL_REVISION',
    'MODEL_REGISTRY',
    'MODEL_DEFAULTS',
    'normalizeModel',
    'pricingModelCandidates',
    'findModelRow',
    'contextWindowForModel',
    'ratesForModel',
];

function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
}

function render(registry, template, format) {
    const revision = JSON.stringify(registry.revision);
    const models = JSON.stringify(sorted(registry.models), null, 4);
    const defaults = JSON.stringify(sorted(registry.defaults), null, 4);
    const footer = format === 'esm'
        ? `export { ${EXPORTS.join(', ')} };`
        : `module.exports = { ${EXPORTS.join(', ')} };`;
    return `${HEADER}\n\nconst MODEL_REVISION = ${revision};\nconst MODEL_REGISTRY = ${models};\nconst MODEL_DEFAULTS = ${defaults};\n\n${template.trim()}\n\n${footer}\n`;
}

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
const check = process.argv.includes('--check');
let drifted = false;

for (const output of OUTPUTS) {
    const expected = render(registry, template, output.format);
    if (check) {
        const actual = fs.existsSync(output.path) ? fs.readFileSync(output.path, 'utf8') : null;
        if (actual !== expected) {
            console.error(`Generated model registry is stale: ${path.relative(REPO_ROOT, output.path)}`);
            drifted = true;
        }
    } else {
        fs.writeFileSync(output.path, expected);
    }
}

if (drifted) process.exitCode = 1;
