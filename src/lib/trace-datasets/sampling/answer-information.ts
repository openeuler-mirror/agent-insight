import { normalizeText, type Candidate, type Policy } from './index';
import { type AgreementFeatures, consensusReplaceSteps } from './answer-consensus';
import { type SharedAnswers } from './answer-shared';
import { INCREMENTAL_POLICY, incrementalPreparedSteps } from './budgeted-incremental';
import { type BlockExperiment } from './budgeted-priced-core';

export const INFORMATION_POLICY = Object.freeze({ ...INCREMENTAL_POLICY, version: 'trace-coverage-v6.21' });

export function* informationFeaturesSteps(base: AgreementFeatures, records: SharedAnswers['records']): Generator<void, AgreementFeatures> {
  const scores = new Map<string, number>(), groupScores = new Map<string, number>(); let work = 0;
  for (const [inputKey, variants] of records) {
    let total = 0;
    for (const variant of variants) {
      const tokens = normalizeText(variant.text).toLowerCase().match(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu) || [];
      const trigrams = new Set<string>();
      for (let i = 2; i < tokens.length; i++) { trigrams.add(JSON.stringify(tokens.slice(i - 2, i + 1))); if (++work % 1024 === 0) yield; }
      const distinct = variant.terms!.size, ratio = tokens.length < 3 ? 1 : trigrams.size / (tokens.length - 2);
      const score = .75 * base.scores.get(variant.keys[0])! + .25 * (distinct / (distinct + 32)) * ratio;
      total += score; for (const key of variant.keys) scores.set(key, score);
      if (++work % 64 === 0) yield;
    }
    groupScores.set(inputKey, total / variants.length);
  }
  return { groups: base.groups, scores, groupScores, comparisons: base.comparisons };
}
export function* informationPreparedSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = INFORMATION_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== INFORMATION_POLICY.version) throw new Error('INVALID_CONFIG');
  const prepared = yield* incrementalPreparedSteps(candidates, answers, limit, { ...policy, version: INCREMENTAL_POLICY.version }, experiment), baseline = prepared.result;
  if (!prepared.shared || !prepared.features) return { result: { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, information: { replacements: 0 } }, features: undefined };
  const features = yield* informationFeaturesSteps(prepared.features, prepared.shared.records), changed = yield* consensusReplaceSteps(candidates, baseline.selected, features);
  return { result: { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version }, information: { replacements: changed.replacements } }, features };
}
export function* informationSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = INFORMATION_POLICY, experiment: BlockExperiment = {}) { return (yield* informationPreparedSteps(candidates, answers, limit, policy, experiment)).result; }
export function informationSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = INFORMATION_POLICY, experiment: BlockExperiment = {}) { const steps = informationSampleSteps(candidates, answers, limit, policy, experiment); let next = steps.next(); while (!next.done) next = steps.next(); return next.value; }
