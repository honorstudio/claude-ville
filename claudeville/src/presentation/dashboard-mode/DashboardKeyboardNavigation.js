import { normalizeStatus } from '../shared/Formatters.js';

const ATTENTION_STATUSES = new Set(['waiting_on_user', 'errored', 'rate_limited']);

export function nextCardId(ids, currentId, direction = 1) {
    if (!ids?.length) return null;
    const step = direction < 0 ? -1 : 1;
    const currentIndex = ids.indexOf(currentId);
    if (currentIndex < 0) return step < 0 ? ids[ids.length - 1] : ids[0];
    return ids[(currentIndex + step + ids.length) % ids.length];
}

export function recoveryCardId(idsBeforeRemoval, removedId) {
    if (!idsBeforeRemoval?.length) return null;
    const removedIndex = idsBeforeRemoval.indexOf(removedId);
    const remaining = idsBeforeRemoval.filter(id => id !== removedId);
    if (!remaining.length) return null;
    if (removedIndex < 0) return remaining[0];
    return remaining[Math.min(removedIndex, remaining.length - 1)];
}

export function attentionAgentIds(agents) {
    return [...(agents || [])]
        .filter(agent => ATTENTION_STATUSES.has(normalizeStatus(agent?.status)))
        .sort((a, b) => {
            const aSince = Number(a.awaitingSince || a.lastSessionActivity || 0);
            const bSince = Number(b.awaitingSince || b.lastSessionActivity || 0);
            return aSince - bSince || String(a.id).localeCompare(String(b.id));
        })
        .map(agent => agent.id);
}

export function isKeyboardEditTarget(element) {
    if (!element) return false;
    const tagName = String(element.tagName || '').toUpperCase();
    return tagName === 'INPUT'
        || tagName === 'TEXTAREA'
        || tagName === 'SELECT'
        || Boolean(element.isContentEditable);
}
