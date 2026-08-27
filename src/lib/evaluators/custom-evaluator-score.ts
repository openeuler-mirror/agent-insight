const SCORE_HINT_PATTERNS: Array<{ pattern: RegExp; explicitHundredScale?: boolean }> = [
  { pattern: /因此[,，][^。]*?\[?\s*(\d{1,3}(?:\.\d+)?)\s*\]?/ },
  { pattern: /应该给出\s*\[?\s*(\d{1,3}(?:\.\d+)?)\s*\]?\s*是合理的评分/ },
  { pattern: /\b(?:score|分数|评分)\s*[:：=]\s*([0-9]{1,3}(?:\.\d+)?)\s*\/\s*100\b/i, explicitHundredScale: true },
  { pattern: /\b(?:score|分数|评分)\s*[:：=]\s*(\d{1,3}(?:\.\d+)?)/i },
];

export function normalizeCustomEvaluatorScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n <= 1) n *= 100;
  return Math.min(100, Math.max(0, n));
}

function pickScoreFromObject(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  for (const key of ['score', 'final_score', 'overall_score', 'rating', '分数', '评分']) {
    const candidate = object[key];
    if (typeof candidate === 'number') return normalizeCustomEvaluatorScore(candidate);
    if (typeof candidate === 'string') {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return normalizeCustomEvaluatorScore(parsed);
    }
  }
  return null;
}

export function parseCustomEvaluatorScore(raw: string): number | null {
  if (!raw) return null;

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], raw].filter((value): value is string => !!value);
  for (const candidate of candidates) {
    try {
      const direct = pickScoreFromObject(JSON.parse(candidate));
      if (direct != null) return direct;
    } catch {}

    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const direct = pickScoreFromObject(JSON.parse(candidate.slice(start, end + 1)));
        if (direct != null) return direct;
      } catch {}
    }
  }

  for (const { pattern, explicitHundredScale } of SCORE_HINT_PATTERNS) {
    const match = raw.match(pattern);
    if (!match) continue;
    const score = Number(match[1]);
    if (Number.isFinite(score)) {
      return explicitHundredScale
        ? Math.min(100, Math.max(0, score))
        : normalizeCustomEvaluatorScore(score);
    }
  }
  return null;
}
