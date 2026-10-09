export type EntityMatchMode = 'exact' | 'fuzzy' | 'substring';

export interface F1MatchConfig {
  matchMode?: EntityMatchMode;
  fuzzyThreshold?: number;
  caseSensitive?: boolean;
  widthNormalization?: boolean;
  whitespaceNormalization?: boolean;
}

export interface EffectiveF1MatchConfig {
  matchMode: EntityMatchMode;
  fuzzyThreshold: number;
  caseSensitive: boolean;
  widthNormalization: boolean;
  whitespaceNormalization: boolean;
}

export interface EntityMatchPair {
  predicted: string;
  reference: string;
  normalizedPredicted: string;
  normalizedReference: string;
  distance?: number;
}

export interface F1MatchGraderResult {
  score: number;
  reason: {
    truePositiveCount: number;
    falsePositiveCount: number;
    falseNegativeCount: number;
    precision: number;
    recall: number;
    f1: number;
    matched: EntityMatchPair[];
    falsePositives: string[];
    falseNegatives: string[];
    predictedEntities: string[];
    referenceEntities: string[];
    discardedEmptyPredictions: number;
    discardedEmptyReferences: number;
    config: EffectiveF1MatchConfig;
  };
}

interface NormalizedEntity {
  raw: string;
  normalized: string;
}

function resolveConfig(config: F1MatchConfig): EffectiveF1MatchConfig {
  const threshold = config.fuzzyThreshold ?? 1;
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new RangeError('fuzzyThreshold 必须是非负整数');
  }
  return {
    matchMode: config.matchMode ?? (config.fuzzyThreshold !== undefined ? 'fuzzy' : 'exact'),
    fuzzyThreshold: threshold,
    caseSensitive: config.caseSensitive ?? true,
    widthNormalization: config.widthNormalization ?? false,
    whitespaceNormalization: config.whitespaceNormalization ?? false,
  };
}

function normalizeEntity(entity: string, config: EffectiveF1MatchConfig): string {
  let normalized = config.widthNormalization ? entity.normalize('NFKC') : entity;
  if (config.whitespaceNormalization) normalized = normalized.replace(/\s+/gu, ' ');
  normalized = normalized.trim();
  if (!config.caseSensitive) normalized = normalized.toLocaleLowerCase('und');
  return normalized;
}

function uniqueEntities(entities: string[], config: EffectiveF1MatchConfig): {
  values: NormalizedEntity[];
  discardedEmpty: number;
} {
  const seen = new Set<string>();
  const values: NormalizedEntity[] = [];
  let discardedEmpty = 0;
  for (const raw of entities) {
    const normalized = normalizeEntity(raw, config);
    if (!normalized) {
      discardedEmpty += 1;
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    values.push({ raw, normalized });
  }
  return { values, discardedEmpty };
}

export function levenshteinDistance(left: string, right: string): number {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  if (leftChars.length > rightChars.length) return levenshteinDistance(right, left);
  let previous = Array.from({ length: leftChars.length + 1 }, (_, index) => index);
  let current = new Array<number>(leftChars.length + 1);
  for (let rightIndex = 1; rightIndex <= rightChars.length; rightIndex++) {
    current[0] = rightIndex;
    for (let leftIndex = 1; leftIndex <= leftChars.length; leftIndex++) {
      const substitution = previous[leftIndex - 1]
        + (leftChars[leftIndex - 1] === rightChars[rightIndex - 1] ? 0 : 1);
      current[leftIndex] = Math.min(
        previous[leftIndex] + 1,
        current[leftIndex - 1] + 1,
        substitution,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[leftChars.length];
}

function pairDistance(
  predicted: NormalizedEntity,
  reference: NormalizedEntity,
  config: EffectiveF1MatchConfig,
): number | null {
  if (config.matchMode === 'exact') {
    return predicted.normalized === reference.normalized ? 0 : null;
  }
  if (config.matchMode === 'substring') {
    return predicted.normalized.includes(reference.normalized)
      || reference.normalized.includes(predicted.normalized)
      ? Math.abs(predicted.normalized.length - reference.normalized.length)
      : null;
  }
  const distance = levenshteinDistance(predicted.normalized, reference.normalized);
  return distance <= config.fuzzyThreshold ? distance : null;
}

function maximumMatching(
  predicted: NormalizedEntity[],
  reference: NormalizedEntity[],
  config: EffectiveF1MatchConfig,
): Array<{ predictedIndex: number; referenceIndex: number; distance: number }> {
  const edges = predicted.map((entity) => reference
    .map((candidate, referenceIndex) => ({ referenceIndex, distance: pairDistance(entity, candidate, config) }))
    .filter((edge): edge is { referenceIndex: number; distance: number } => edge.distance !== null)
    .sort((left, right) => left.distance - right.distance || left.referenceIndex - right.referenceIndex));
  const referenceToPredicted = new Array<number>(reference.length).fill(-1);

  const augment = (predictedIndex: number, seenReferences: boolean[]): boolean => {
    for (const edge of edges[predictedIndex]) {
      if (seenReferences[edge.referenceIndex]) continue;
      seenReferences[edge.referenceIndex] = true;
      const occupiedBy = referenceToPredicted[edge.referenceIndex];
      if (occupiedBy === -1 || augment(occupiedBy, seenReferences)) {
        referenceToPredicted[edge.referenceIndex] = predictedIndex;
        return true;
      }
    }
    return false;
  };

  for (let predictedIndex = 0; predictedIndex < predicted.length; predictedIndex++) {
    augment(predictedIndex, new Array<boolean>(reference.length).fill(false));
  }

  return referenceToPredicted
    .map((predictedIndex, referenceIndex) => ({ predictedIndex, referenceIndex }))
    .filter((pair) => pair.predictedIndex >= 0)
    .map((pair) => ({
      ...pair,
      distance: pairDistance(predicted[pair.predictedIndex], reference[pair.referenceIndex], config) ?? 0,
    }))
    .sort((left, right) => left.predictedIndex - right.predictedIndex);
}

export function gradeF1Match(
  predictedEntities: string[],
  referenceEntities: string[],
  config: F1MatchConfig = {},
): F1MatchGraderResult {
  const effectiveConfig = resolveConfig(config);
  const predicted = uniqueEntities(predictedEntities, effectiveConfig);
  const reference = uniqueEntities(referenceEntities, effectiveConfig);
  const matching = maximumMatching(predicted.values, reference.values, effectiveConfig);
  const matchedPredictionIndices = new Set(matching.map((pair) => pair.predictedIndex));
  const matchedReferenceIndices = new Set(matching.map((pair) => pair.referenceIndex));
  const truePositiveCount = matching.length;
  const falsePositiveCount = predicted.values.length - truePositiveCount;
  const falseNegativeCount = reference.values.length - truePositiveCount;
  const precision = predicted.values.length === 0 ? 1 : truePositiveCount / predicted.values.length;
  const recall = reference.values.length === 0 ? 1 : truePositiveCount / reference.values.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const matched = matching.map(({ predictedIndex, referenceIndex, distance }) => ({
    predicted: predicted.values[predictedIndex].raw,
    reference: reference.values[referenceIndex].raw,
    normalizedPredicted: predicted.values[predictedIndex].normalized,
    normalizedReference: reference.values[referenceIndex].normalized,
    ...(effectiveConfig.matchMode === 'fuzzy' ? { distance } : {}),
  }));
  const falsePositives = predicted.values
    .filter((_, index) => !matchedPredictionIndices.has(index))
    .map((entity) => entity.raw);
  const falseNegatives = reference.values
    .filter((_, index) => !matchedReferenceIndices.has(index))
    .map((entity) => entity.raw);

  return {
    score: f1,
    reason: {
      truePositiveCount,
      falsePositiveCount,
      falseNegativeCount,
      precision,
      recall,
      f1,
      matched,
      falsePositives,
      falseNegatives,
      predictedEntities: predicted.values.map((entity) => entity.raw),
      referenceEntities: reference.values.map((entity) => entity.raw),
      discardedEmptyPredictions: predicted.discardedEmpty,
      discardedEmptyReferences: reference.discardedEmpty,
      config: effectiveConfig,
    },
  };
}
