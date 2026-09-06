import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');

export function fromRoot(...parts) {
    return path.join(REPO_ROOT, ...parts);
}

export async function loadConfigExports(relativePath, exportNames) {
    const filePath = fromRoot(relativePath);
    const source = await readFile(filePath, 'utf8');
    const transformed = source.replace(
        /export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g,
        'const $1 =',
    );
    if (/^\s*export\s/m.test(transformed)) {
        throw new Error(`Unsupported export syntax in ${relativePath}`);
    }

    const returnFields = exportNames
        .map((name) => `${JSON.stringify(name)}: ${name}`)
        .join(', ');
    const script = new vm.Script(`${transformed}\n;({ ${returnFields} });`, {
        filename: filePath,
    });
    return script.runInNewContext(Object.freeze({ console }));
}

export async function loadManifestIds(relativePath = 'claudeville/assets/sprites/manifest.yaml') {
    const source = await readFile(fromRoot(relativePath), 'utf8');
    return new Set(
        Array.from(source.matchAll(/^\s*-\s+id:\s*["']?([^"'\s#]+)["']?/gm))
            .map((match) => match[1]),
    );
}
