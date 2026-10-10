export type MultiCandidateScoring = 'any' | 'fraction';

export interface ExactMatchConfig {
  caseSensitive?: boolean;
  caseInsensitive?: boolean;
  punctuationInsensitive?: boolean;
  whitespaceNormalization?: boolean;
  widthNormalization?: boolean;
  multiCandidateScoring?: MultiCandidateScoring;
}

export interface EffectiveExactMatchConfig {
  caseSensitive: boolean;
  punctuationInsensitive: boolean;
  whitespaceNormalization: boolean;
  widthNormalization: boolean;
  multiCandidateScoring: MultiCandidateScoring;
}

export interface ExactMatchCandidateResult {
  raw: string;
  normalized: string;
  matched: boolean;
}

export interface ExactMatchGraderResult {
  score: number;
  reason: {
    rawOutput: string;
    normalizedOutput: string;
    candidates: ExactMatchCandidateResult[];
    matchedCandidateIndices: number[];
    matchCount: number;
    candidateCount: number;
    config: EffectiveExactMatchConfig;
  };
}

export function resolveExactMatchConfig(config: ExactMatchConfig = {}): EffectiveExactMatchConfig {
  const caseSensitive = typeof config.caseSensitive === 'boolean'
    ? config.caseSensitive
    : !(config.caseInsensitive ?? false);
  return {
    caseSensitive,
    punctuationInsensitive: config.punctuationInsensitive ?? false,
    whitespaceNormalization: config.whitespaceNormalization ?? false,
    widthNormalization: config.widthNormalization ?? false,
    multiCandidateScoring: config.multiCandidateScoring ?? 'any',
  };
}

export function normalizeExactMatchText(text: string, config: EffectiveExactMatchConfig): string {
  let normalized = config.widthNormalization ? text.normalize('NFKC') : text;
  if (!config.caseSensitive) normalized = normalized.toLocaleLowerCase('und');
  if (config.punctuationInsensitive) normalized = normalized.replace(/\p{P}+/gu, '');
  if (config.whitespaceNormalization) normalized = normalized.replace(/\s+/gu, ' ').trim();
  return normalized;
}

export function gradeExactMatch(
  output: string,
  reference: string | string[],
  config: ExactMatchConfig = {},
): ExactMatchGraderResult {
  const effectiveConfig = resolveExactMatchConfig(config);
  const rawCandidates = Array.isArray(reference) ? reference : [reference];
  const normalizedOutput = normalizeExactMatchText(output, effectiveConfig);
  const candidates = rawCandidates.map((raw) => {
    const normalized = normalizeExactMatchText(raw, effectiveConfig);
    return { raw, normalized, matched: normalizedOutput === normalized };
  });
  const matchedCandidateIndices = candidates
    .map((candidate, index) => (candidate.matched ? index : -1))
    .filter((index) => index >= 0);
  const matchCount = matchedCandidateIndices.length;
  const score = effectiveConfig.multiCandidateScoring === 'fraction'
    ? (candidates.length === 0 ? 0 : matchCount / candidates.length)
    : (matchCount > 0 ? 1 : 0);

  return {
    score,
    reason: {
      rawOutput: output,
      normalizedOutput,
      candidates,
      matchedCandidateIndices,
      matchCount,
      candidateCount: candidates.length,
      config: effectiveConfig,
    },
  };
}
