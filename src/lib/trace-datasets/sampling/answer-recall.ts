import { hash, lexicalSteps, normalizeText, type Candidate, type Policy } from './index';
import { consensusReplaceSteps, type AgreementFeatures } from './answer-consensus';
import { acceleratedSampleSteps, ACCELERATED_POLICY } from './budgeted-accelerated';
import { type BlockExperiment } from './budgeted-block';

export const RECALL_POLICY = Object.freeze({ ...ACCELERATED_POLICY, version: 'trace-coverage-v6.9' });

export function* recallFeaturesSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>): Generator<void, AgreementFeatures> {
  if (answers.size !== candidates.length || new Set(candidates.map(c => c.key)).size !== candidates.length) throw new Error('SOURCE_CORRUPT');
  const groups = new Map<string, Candidate[]>(), scores = new Map<string, number>(), groupScores = new Map<string, number>();
  let work = 0, comparisons = 0;
  for (const row of candidates) {
    if (typeof answers.get(row.key) !== 'string' || !answers.get(row.key)!.trim()) throw new Error('SOURCE_CORRUPT');
    const list = groups.get(row.inputKey) || []; list.push(row); groups.set(row.inputKey, list);
    if (++work % 256 === 0) yield;
  }
  for (const [inputKey, rows] of groups) {
    const distinct = new Map<string, { keys: string[]; terms: Set<string> }>();
    for (const row of [...rows].sort((a, b) => a.key.localeCompare(b.key))) {
      const text = normalizeText(answers.get(row.key)!), id = hash([text]);
      const old = distinct.get(id);
      if (old) old.keys.push(row.key);
      else { const feature = yield* lexicalSteps(text); distinct.set(id, { keys: [row.key], terms: new Set(feature.terms) }); }
    }
    const variants = [...distinct.values()], values: number[] = [];
    for (const answer of variants) {
      let sum = 0, support = 0;
      for (const peer of variants) {
        if (peer === answer) continue;
        let intersection = 0;
        const [small, large] = answer.terms.size <= peer.terms.size ? [answer.terms, peer.terms] : [peer.terms, answer.terms];
        for (const term of small) { intersection += Number(large.has(term)); if (++work % 1024 === 0) yield; }
        const denominator = 4 * peer.terms.size + answer.terms.size;
        sum += denominator ? 5 * intersection / denominator : 0; comparisons++;
        if (++support === 32) break;
      }
      const score = support ? sum / support : 0;
      values.push(score); for (const key of answer.keys) scores.set(key, score);
    }
    groupScores.set(inputKey, values.reduce((a, b) => a + b, 0) / values.length);
    if (++work % 64 === 0) yield;
  }
  return { scores, groups, groupScores, comparisons };
}

export function* recallPreparedSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = RECALL_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== RECALL_POLICY.version) throw new Error('INVALID_CONFIG');
  const baseline = yield* acceleratedSampleSteps(candidates, answers, limit, { ...policy, version: ACCELERATED_POLICY.version }, experiment);
  if (!baseline.optimization.feasible) return { result: { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, agreement: { ...baseline.agreement, recallReplacements: 0, recallComparisons: 0 } }, features: undefined };
  const features = yield* recallFeaturesSteps(candidates, answers);
  const changed = yield* consensusReplaceSteps(candidates, baseline.selected, features);
  const result = { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version }, agreement: { ...baseline.agreement, recallReplacements: changed.replacements, recallComparisons: features.comparisons } };
  return { result, features };
}

export function* recallSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = RECALL_POLICY, experiment: BlockExperiment = {}) {
  const prepared = yield* recallPreparedSteps(candidates, answers, limit, policy, experiment);
  return prepared.result;
}

export function recallSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = RECALL_POLICY, experiment: BlockExperiment = {}) {
  const steps = recallSampleSteps(candidates, answers, limit, policy, experiment);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}
