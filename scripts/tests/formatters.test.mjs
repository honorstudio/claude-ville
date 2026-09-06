import test from 'node:test';
import assert from 'node:assert/strict';

import { formatToolDetail, shortenHomePath } from '../../claudeville/src/presentation/shared/Formatters.js';

test('formatToolDetail keeps the filename on long POSIX paths', () => {
    const detail = '/Users/ahirice/Documents/git/claude-ville/src/components/Widget.tsx';
    const formatted = formatToolDetail(detail, { max: 28 });

    assert.equal(formatted, '…/components/Widget.tsx');
    assert.equal(formatToolDetail('git/config/history.json', { max: 22 }), '…/config/history.json');
    assert.ok(formatted.length <= 28);
    assert.doesNotMatch(formatted, /^\/(?:Users|home)\//);
});

test('formatToolDetail makes paths inside the project relative', () => {
    assert.equal(
        formatToolDetail('/home/ahirice/project/src/components/Widget.tsx', {
            projectPath: '/home/ahirice/project',
        }),
        'src/components/Widget.tsx',
    );
});

test('formatToolDetail handles Windows home and project paths', () => {
    const detail = 'C:\\Users\\ahirice\\project\\src\\components\\Widget.tsx';
    const projectPath = 'C:\\Users\\ahirice\\project';

    assert.equal(shortenHomePath(detail), '~\\project\\src\\components\\Widget.tsx');
    assert.equal(
        formatToolDetail(detail, { projectPath }),
        'src\\components\\Widget.tsx',
    );
    assert.equal(
        formatToolDetail('C:/Users/Ahirice/project/src/Widget.tsx', {
            projectPath: 'c:/Users/ahirice/project',
        }),
        'src/Widget.tsx',
    );
});

test('formatToolDetail shortens home paths embedded in commands', () => {
    const formatted = formatToolDetail(
        'git diff -- /Users/ahirice/Documents/git/claude-ville/src/Widget.tsx',
        { max: 64 },
    );

    assert.equal(formatted, 'git diff -- ~/Documents/git/claude-ville/src/Widget.tsx');
    assert.doesNotMatch(formatted, /\/(?:Users|home)\//);
});

test('formatToolDetail uses ordinary truncation for non-path details', () => {
    assert.equal(formatToolDetail('Searching for matching symbols', { max: 12 }), 'Searching f…');
});
