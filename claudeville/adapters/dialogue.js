/**
 * Provenance-tagged villager dialogue.
 *
 * ClaudeVille speech bubbles used to interleave hand-written preset phrases
 * with fragments of real session text, which made it impossible to tell what
 * an agent actually said. This module is the single place where session text
 * becomes displayable dialogue, and every string it emits carries where it
 * came from and whether it was altered.
 *
 * Three rules hold everywhere:
 *   1. Nothing is invented. Adapters emit only strings the model itself wrote.
 *   2. Altered text says so. Trimming sets `fidelity: 'excerpt'`; redaction
 *      sets `redacted: true`. Only untouched text is `'verbatim'`.
 *   3. Absence is reported, never faked. `observedSources` records what the
 *      bounded tail scan actually saw; it is not a provider capability claim.
 *
 * Harness-derived labels (tool names, phases) are NOT produced here. The
 * presentation layer derives those from `lastTool` and renders them as status
 * chips, never as speech.
 */

const os = require('os');

// Bubble/chip label budget. The renderer truncates by measured pixel width on
// top of this; the cap exists so a runaway reasoning paragraph cannot inflate
// every poll payload.
const DIALOGUE_TEXT_CAP = 80;
// Full text retained for the selected-agent narration panel. Grok reasoning
// summaries run to ~850 chars at p90, so this bounds the tail without
// discarding typical entries.
const DIALOGUE_FULL_CAP = 400;
// Dialogue older than this is not current work and must not be presented as
// what the agent is doing now.
const DIALOGUE_MAX_AGE_MS = 90_000;
// Clock skew tolerance for timestamps that appear to be in the future.
const DIALOGUE_FUTURE_SKEW_MS = 5_000;
// Two candidates within this window count as simultaneous, so the source
// hierarchy — not millisecond noise — decides which one speaks.
const DIALOGUE_TIE_WINDOW_MS = 2_000;

const AUTHORSHIP = Object.freeze({ MODEL: 'model', HARNESS: 'harness' });
const FIDELITY = Object.freeze({ VERBATIM: 'verbatim', EXCERPT: 'excerpt', DERIVED: 'derived' });

/**
 * Dialogue kinds, ordered by how directly they describe the current action.
 * `intent` and `plan` are the model naming its own work; `thinking` is the
 * model reasoning aloud (long-form, rendered as a chip); `assistant` is prose
 * addressed to the user, which usually reports a result rather than intent.
 */
const KIND_RANK = Object.freeze({
  intent: 0,
  plan: 1,
  thinking: 2,
  assistant: 3,
});

const DIALOGUE_KINDS = Object.freeze(Object.keys(KIND_RANK));

/**
 * Server-side source gate.
 *
 * Every kind is enabled by default: the operator's chosen posture is "all
 * observed sources on, sanitized". The gate exists here, at extraction time,
 * rather than in the renderer because a disabled source must never be
 * serialized to the browser in the first place — hiding already-transmitted
 * reasoning in the UI would be theatre.
 *
 * Override with CLAUDEVILLE_DIALOGUE_SOURCES as a comma-separated allowlist of
 * kinds, e.g. `intent,plan` to keep tool intent while withholding reasoning
 * and assistant prose. An empty value disables dialogue entirely.
 */
let _enabledKinds;
function enabledKinds() {
  if (_enabledKinds) return _enabledKinds;
  const raw = process.env.CLAUDEVILLE_DIALOGUE_SOURCES;
  if (raw === undefined) {
    _enabledKinds = new Set(DIALOGUE_KINDS);
    return _enabledKinds;
  }
  const requested = String(raw)
    .split(',')
    .map((kind) => kind.trim().toLowerCase())
    .filter((kind) => Object.prototype.hasOwnProperty.call(KIND_RANK, kind));
  _enabledKinds = new Set(requested);
  return _enabledKinds;
}

function isKindEnabled(kind) {
  return enabledKinds().has(String(kind));
}

function emptyObservedSources() {
  return { toolIntent: false, planStep: false, thinkingPlaintext: false, assistantText: false };
}

let _segmenter;
function segmenter() {
  if (_segmenter === undefined) {
    try {
      _segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      _segmenter = null;
    }
  }
  return _segmenter;
}

/** Grapheme clusters when available, code points otherwise. Never UTF-16 units. */
function toUnits(text) {
  const seg = segmenter();
  if (!seg) return Array.from(text);
  const units = [];
  for (const { segment } of seg.segment(text)) units.push(segment);
  return units;
}

/**
 * Trim to `cap` display units at a word boundary.
 * Returns `cut: true` when anything was removed, which forces the caller to
 * downgrade fidelity from verbatim to excerpt.
 */
function trimToCap(text, cap = DIALOGUE_TEXT_CAP) {
  const value = String(text || '');
  const units = toUnits(value);
  if (units.length <= cap) return { text: value, cut: false };
  // Reserve one unit for the ellipsis.
  const head = units.slice(0, Math.max(1, cap - 1)).join('');
  const lastSpace = head.lastIndexOf(' ');
  // Only honor a word boundary that leaves a useful amount of text; otherwise
  // a long unbroken token (a path, a command) would collapse to nothing.
  const body = lastSpace > cap * 0.5 ? head.slice(0, lastSpace) : head;
  return { text: `${body.replace(/[\s,;:.\-]+$/, '')}…`, cut: true };
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidi overrides can visually reorder a sanitized string back into something
// misleading, so they are stripped rather than escaped.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const PEM_BLOCK = /-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g;
const SECRET_TOKENS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const URL_WITH_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const URL_TAIL = /(\bhttps?:\/\/[^\s"'<>`]*?)[?#][^\s"'<>`]*/gi;
const REDACTED = '[redacted]';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove secrets and machine-identifying paths from model-authored text.
 *
 * Absolute paths are rewritten rather than dropped: `$PROJECT/src/foo.js` is
 * still meaningful to the operator while carrying no home directory or client
 * name. Redaction cannot recognize customer names or private prompt content,
 * so this reduces exposure — it does not guarantee a safe screenshare.
 */
function sanitizeDialogueText(text, { project = null, home = os.homedir() } = {}) {
  let value = String(text || '');
  if (!value) return { text: '', redacted: false };

  // Markup removal runs first and is deliberately NOT counted as redaction.
  // Reasoning text is written as Markdown ("**Confirming safe filename
  // handling**"), and the emphasis characters are formatting, not words. Every
  // word survives, so the line stays verbatim; only the syntax goes.
  value = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '');

  const before = value;
  value = value.replace(PEM_BLOCK, REDACTED);
  value = value.replace(CONTROL_CHARS, ' ').replace(BIDI_CONTROLS, '');
  for (const pattern of SECRET_TOKENS) value = value.replace(pattern, REDACTED);
  value = value.replace(SECRET_ASSIGNMENT, (_match, key) => `${key}=${REDACTED}`);
  value = value.replace(URL_WITH_CREDENTIALS, '$1');
  value = value.replace(URL_TAIL, '$1');
  value = value.replace(EMAIL, REDACTED);

  // Longest prefix first so a project inside the home directory maps to
  // $PROJECT rather than $HOME.
  const roots = [];
  if (project) roots.push([String(project), '$PROJECT']);
  if (home) roots.push([String(home), '$HOME']);
  roots.sort((a, b) => b[0].length - a[0].length);
  for (const [root, token] of roots) {
    if (!root || root === '/') continue;
    value = value.replace(new RegExp(escapeRegExp(root), 'g'), token);
  }

  value = value.replace(/\s+/g, ' ').trim();
  return { text: value, redacted: value !== before.replace(/\s+/g, ' ').trim() };
}

/**
 * Build a dialogue candidate from raw model-authored text.
 * Returns null when nothing displayable survives sanitation.
 */
function makeDialogue({
  text,
  kind,
  source,
  observedAt,
  actionId = null,
  project = null,
  home = undefined,
  textCap = DIALOGUE_TEXT_CAP,
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(KIND_RANK, String(kind))) return null;
  if (!isKindEnabled(kind)) return null;
  const at = Number(observedAt);
  if (!Number.isFinite(at) || at <= 0) return null;

  const sanitized = sanitizeDialogueText(text, { project, home });
  if (!sanitized.text) return null;

  const full = trimToCap(sanitized.text, DIALOGUE_FULL_CAP);
  const label = trimToCap(sanitized.text, textCap);
  return {
    text: label.text,
    // Only carried when the label lost something, so short intent phrases add
    // no payload. The narration panel reads this.
    full: full.text === label.text ? null : full.text,
    kind: String(kind),
    source: String(source || ''),
    authorship: AUTHORSHIP.MODEL,
    fidelity: label.cut ? FIDELITY.EXCERPT : FIDELITY.VERBATIM,
    redacted: sanitized.redacted,
    observedAt: at,
    actionId: actionId == null ? null : String(actionId),
  };
}

function isFresh(candidate, now) {
  const age = now - candidate.observedAt;
  return age <= DIALOGUE_MAX_AGE_MS && age >= -DIALOGUE_FUTURE_SKEW_MS;
}

/**
 * Choose which candidate speaks.
 *
 * Newest wins. This is the load-bearing rule: a stale plan step outranking a
 * newer tool call is exactly how the previous system ended up showing
 * confident text about work the agent had already moved on from. The source
 * hierarchy only breaks ties inside DIALOGUE_TIE_WINDOW_MS, where ordering by
 * timestamp would be arbitrary anyway.
 */
function pickDialogue(candidates, { now = Date.now() } = {}) {
  const fresh = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate && typeof candidate.text === 'string' && candidate.text)
    .filter((candidate) => isFresh(candidate, now));
  if (!fresh.length) return null;

  const newest = fresh.reduce((max, c) => (c.observedAt > max ? c.observedAt : max), 0);
  let best = null;
  for (const candidate of fresh) {
    if (newest - candidate.observedAt > DIALOGUE_TIE_WINDOW_MS) continue;
    if (!best) { best = candidate; continue; }
    const rank = KIND_RANK[candidate.kind] - KIND_RANK[best.kind];
    if (rank < 0 || (rank === 0 && candidate.observedAt > best.observedAt)) best = candidate;
  }
  return best;
}

function normalizeObservedSources(value) {
  const base = emptyObservedSources();
  if (!value || typeof value !== 'object') return base;
  for (const key of Object.keys(base)) base[key] = value[key] === true;
  return base;
}

/** Shape gate for dialogue arriving from an adapter or over the wire. */
function normalizeDialogue(value) {
  if (!value || typeof value !== 'object') return null;
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (!text) return null;
  const at = Number(value.observedAt);
  if (!Number.isFinite(at) || at <= 0) return null;
  const kind = Object.prototype.hasOwnProperty.call(KIND_RANK, String(value.kind))
    ? String(value.kind)
    : null;
  if (!kind) return null;
  const fidelity = Object.values(FIDELITY).includes(value.fidelity)
    ? value.fidelity
    : FIDELITY.EXCERPT;
  const authorship = value.authorship === AUTHORSHIP.HARNESS
    ? AUTHORSHIP.HARNESS
    : AUTHORSHIP.MODEL;
  return {
    text: trimToCap(text, DIALOGUE_TEXT_CAP).text,
    full: typeof value.full === 'string' && value.full.trim()
      ? trimToCap(value.full.trim(), DIALOGUE_FULL_CAP).text
      : null,
    kind,
    source: typeof value.source === 'string' ? value.source : '',
    authorship,
    fidelity,
    redacted: value.redacted === true,
    observedAt: at,
    actionId: value.actionId == null ? null : String(value.actionId),
  };
}

module.exports = {
  AUTHORSHIP,
  DIALOGUE_FULL_CAP,
  DIALOGUE_KINDS,
  DIALOGUE_MAX_AGE_MS,
  DIALOGUE_TEXT_CAP,
  DIALOGUE_TIE_WINDOW_MS,
  FIDELITY,
  KIND_RANK,
  enabledKinds,
  isKindEnabled,
  emptyObservedSources,
  makeDialogue,
  normalizeDialogue,
  normalizeObservedSources,
  pickDialogue,
  sanitizeDialogueText,
  trimToCap,
};
