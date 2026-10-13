import { type Candidate, type Policy } from './index';
import { PRICED_CORE_POLICY, pricedCoreSampleSteps, type BlockExperiment } from './budgeted-priced-core';
import { directAnswerFeaturesSteps } from './answer-direct';
import { consensusReplaceSteps } from './answer-consensus';

export const PRICED_POLICY = PRICED_CORE_POLICY;

export function* pricedPreparedSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = PRICED_POLICY, experiment: BlockExperiment = {}) {
  const baseline = yield* pricedCoreSampleSteps(candidates, limit, policy, experiment);
  if (!baseline.optimization.feasible) return { result: { ...baseline, weighted: { replacements: 0, comparisons: 0 } }, features: undefined };
  const features = yield* directAnswerFeaturesSteps(candidates, answers), changed = yield* consensusReplaceSteps(candidates, baseline.selected, features);
  const result = { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, weighted: { replacements: changed.replacements, comparisons: features.comparisons } };
  return { result, features };
}

export function* pricedSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = PRICED_POLICY, experiment: BlockExperiment = {}) {
  return (yield* pricedPreparedSteps(candidates, answers, limit, policy, experiment)).result;
}

export function pricedSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = PRICED_POLICY, experiment: BlockExperiment = {}) {
  const steps = pricedSampleSteps(candidates, answers, limit, policy, experiment);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}
