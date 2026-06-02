export function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], raw].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct) return direct;
    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < candidate.length; i += 1) {
      if (candidate[i] === '{') depth += 1;
      if (candidate[i] === '}') depth -= 1;
      if (depth === 0) {
        const parsed = tryParse(candidate.slice(start, i + 1));
        if (parsed) return parsed;
        break;
      }
    }
  }
  return null;
}

function tryParse(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value.replace(/,(\s*[}\]])/g, '$1'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function stringField(obj: Record<string, unknown>, key: string, fallback = ''): string {
  const value = obj[key];
  return typeof value === 'string' ? value : fallback;
}

export function numberField(obj: Record<string, unknown>, key: string, fallback: number): number {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function booleanField(obj: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = obj[key];
  return typeof value === 'boolean' ? value : fallback;
}
