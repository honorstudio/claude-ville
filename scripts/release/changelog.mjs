const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const DATE = `${MONTH} \\d{1,2}(?:–\\d{1,2})?, \\d{4}`;
const VERSION = '0\\.\\d+\\.\\d+(?:\\.\\d+)?';

const NAMED_HEADER = new RegExp(
    `^## v(${VERSION}) — \\*([^*]+)\\* · (${DATE})$`
);
const HOTFIX_HEADER = new RegExp(
    `^## v(${VERSION}) · (${DATE}) — Hotfix$`
);

export function parseReleaseHeader(line) {
    const named = line.match(NAMED_HEADER);
    if (named) {
        return {
            version: named[1],
            type: 'named',
            name: named[2],
            date: named[3],
            hasDateRange: named[3].includes('–'),
        };
    }

    const hotfix = line.match(HOTFIX_HEADER);
    if (hotfix) {
        return {
            version: hotfix[1],
            type: 'hotfix',
            name: 'Hotfix',
            date: hotfix[2],
            hasDateRange: hotfix[2].includes('–'),
        };
    }

    return null;
}

export function extractReleaseSection(text, version) {
    const headings = [...text.matchAll(/^## v[^\r\n]*$/gm)];
    const index = headings.findIndex((match) => {
        const parsed = parseReleaseHeader(match[0]);
        return parsed?.version === version;
    });
    if (index === -1) return null;

    const start = headings[index].index;
    const end = headings[index + 1]?.index ?? text.length;
    return text.slice(start, end).replace(/\r?\n\r?\n---\r?\n\s*$/, '\n');
}
