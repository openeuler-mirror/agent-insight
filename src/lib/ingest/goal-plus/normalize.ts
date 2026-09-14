import type { GoalPlusSnapshotEnvelopeV1 } from './contracts';

const SECRET_KEY = /(?:^|[-_.])(api[-_]?key|authorization|token|secret|password|passwd|private[-_]?key|cookie|hidden[-_]?gold|gold[-_]?answer)(?:$|[-_.])/i;
const HIDDEN_KEY = /(?:^|[-_.])(hidden[-_]?grader|hidden[-_]?answer|gold[-_]?label|private[-_]?dataset)(?:$|[-_.])/i;
const INLINE_SECRET = /\b((?:api[-_]?key|token|secret|password|passwd))\b\s*([=:])\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const ABSOLUTE_PATH = /(?:\b[A-Za-z]:[\\/][^\s"'`<>|*?]+|\\\\[^\s"'`<>|*?]+(?:\\[^\s"'`<>|*?]+)+|\/(?:Users|home)\/[^\s/"'`]+(?:\/[^\s"'`]+)*)/g;
const MAX_STRING = 32 * 1024;
const MAX_ARRAY = 512;
const MAX_KEYS = 512;
const MAX_DEPTH = 12;

export interface SanitizedGoalPlusPayload {
  payload: Record<string, unknown>;
  truncatedFields: string[];
  removedFields: string[];
}

function cleanString(value: string, path: string, truncated: Set<string>): string {
  const redacted = value
    .replace(INLINE_SECRET, (_match, key, separator) => `${key}${separator}[REDACTED]`)
    .replace(ABSOLUTE_PATH, '[LOCAL_PATH]');
  if (Array.from(redacted).length <= MAX_STRING) return redacted;
  truncated.add(path);
  return `${Array.from(redacted).slice(0, MAX_STRING).join('')}...[TRUNCATED]`;
}

function sanitize(
  value: unknown,
  path: string,
  depth: number,
  truncated: Set<string>,
  removed: Set<string>,
): unknown {
  if (depth > MAX_DEPTH) {
    truncated.add(path);
    return '[TRUNCATED_DEPTH]';
  }
  if (typeof value === 'string') return cleanString(value, path, truncated);
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) truncated.add(path);
    return value.slice(0, MAX_ARRAY).map((item, index) => (
      sanitize(item, `${path}[${index}]`, depth + 1, truncated, removed)
    ));
  }
  if (typeof value !== 'object') return String(value);

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_KEYS) truncated.add(path);
  for (const [key, item] of entries.slice(0, MAX_KEYS)) {
    const itemPath = path ? `${path}.${key}` : key;
    if (SECRET_KEY.test(key) || HIDDEN_KEY.test(key)) {
      removed.add(itemPath);
      continue;
    }
    result[key] = sanitize(item, itemPath, depth + 1, truncated, removed);
  }
  return result;
}

export function sanitizeGoalPlusPayload(snapshot: GoalPlusSnapshotEnvelopeV1): SanitizedGoalPlusPayload {
  const truncated = new Set(snapshot.redaction.truncatedFields);
  const removed = new Set(snapshot.redaction.removedFields);
  const payload = sanitize(snapshot.payload, '', 0, truncated, removed);
  return {
    payload: (payload && typeof payload === 'object' && !Array.isArray(payload))
      ? payload as Record<string, unknown>
      : {},
    truncatedFields: [...truncated].filter(Boolean).sort(),
    removedFields: [...removed].filter(Boolean).sort(),
  };
}

export function sanitizeGoalPlusLabel(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return cleanString(value.trim(), 'source.label', new Set()).slice(0, 160);
}

export function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export function dateValue(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function jsonString(value: unknown, fallback: unknown): string {
  return JSON.stringify(value === undefined ? fallback : value);
}
