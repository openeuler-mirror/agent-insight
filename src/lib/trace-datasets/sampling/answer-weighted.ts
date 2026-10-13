import { lexicalSteps, type Candidate, type Policy } from './index';
import { consensusReplaceSteps, type AgreementFeatures } from './answer-consensus';
import { type SharedAnswers } from './answer-shared';
import { REUSED_POLICY, reusedPreparedSteps } from './budgeted-reused';
import { type BlockExperiment } from './budgeted-indexed';

export const WEIGHTED_POLICY = Object.freeze({ ...REUSED_POLICY, version: 'trace-coverage-v6.12' });

export function* weightedFeaturesSteps(shared: SharedAnswers): Generator<void, AgreementFeatures> {
  const frequencies = new Map<string, number>(), scores = new Map<string, number>(), groupScores = new Map<string, number>();
  let work = 0, comparisons = 0;
  for (const variants of shared.records.values()) {
    const union = new Set<string>();
    for (const answer of variants) {
      if (!answer.terms) answer.terms = new Set((yield* lexicalSteps(answer.text)).terms);
      for (const term of answer.terms) { union.add(term); if (++work % 1024 === 0) yield; }
    }
    for (const term of union) { frequencies.set(term, (frequencies.get(term) || 0) + 1); if (++work % 1024 === 0) yield; }
  }
  const weights = new Map<string, number>();
  for (const [term, count] of frequencies) { weights.set(term, 1 + Math.log((shared.records.size + 1) / (count + 1))); if (++work % 1024 === 0) yield; }
  for (const [inputKey, variants] of shared.records) {
    const masses: number[] = [], values: number[] = [];
    for (const answer of variants) {
      let mass = 0; for (const term of answer.terms!) { mass += weights.get(term)!; if (++work % 1024 === 0) yield; } masses.push(mass);
    }
    for (let i = 0; i < variants.length; i++) {
      const answer = variants[i]; let sum = 0, support = 0;
      for (let j = 0; j < variants.length; j++) {
        if (i === j) continue;
        const peer = variants[j]; let intersection = 0;
        const [small, large] = answer.terms!.size <= peer.terms!.size ? [answer.terms!, peer.terms!] : [peer.terms!, answer.terms!];
        for (const term of small) { if (large.has(term)) intersection += weights.get(term)!; if (++work % 1024 === 0) yield; }
        const denominator = 4 * masses[j] + masses[i]; sum += denominator ? 5 * intersection / denominator : 0; comparisons++;
        if (++support === 32) break;
      }
      const score = support ? sum / support : 0; values.push(score);
      for (const key of answer.keys) scores.set(key, score);
    }
    groupScores.set(inputKey, values.reduce((a, b) => a + b, 0) / values.length);
    if (++work % 64 === 0) yield;
  }
  return { groups: shared.agreement.groups, scores, groupScores, comparisons };
}

export function* weightedPreparedSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = WEIGHTED_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== WEIGHTED_POLICY.version) throw new Error('INVALID_CONFIG');
  const prepared = yield* reusedPreparedSteps(candidates, answers, limit, { ...policy, version: REUSED_POLICY.version }, experiment), baseline = prepared.result;
  if (!prepared.shared) return { result: { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, weighted: { replacements: 0, comparisons: 0 } }, features: undefined };
  const features = yield* weightedFeaturesSteps(prepared.shared), changed = yield* consensusReplaceSteps(candidates, baseline.selected, features);
  const result = { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version }, weighted: { replacements: changed.replacements, comparisons: features.comparisons } };
  return { result, features };
}

export function* weightedSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = WEIGHTED_POLICY, experiment: BlockExperiment = {}) {
  return (yield* weightedPreparedSteps(candidates, answers, limit, policy, experiment)).result;
}

export function weightedSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = WEIGHTED_POLICY, experiment: BlockExperiment = {}) {
  const steps = weightedSampleSteps(candidates, answers, limit, policy, experiment);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}
