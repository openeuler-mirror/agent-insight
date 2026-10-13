import { type Candidate, type Policy } from './index';
import { CROSSING_POLICY, crossingSampleSteps } from './budgeted-crossing';
import { directAnswerFeaturesSteps } from './answer-direct';
import { consensusReplaceSteps } from './answer-consensus';
import { type BlockExperiment } from './budgeted-priced-core';

export const HIGH_RECALL_POLICY = Object.freeze({ ...CROSSING_POLICY, version: 'trace-coverage-v6.16' });

export function* highRecallSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = HIGH_RECALL_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== HIGH_RECALL_POLICY.version) throw new Error('INVALID_CONFIG');
  const baseline = yield* crossingSampleSteps(candidates, answers, limit, { ...policy, version: CROSSING_POLICY.version }, experiment);
  if (!baseline.optimization.feasible) return { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, highRecall: { replacements: 0, comparisons: 0 } };
  const features = yield* directAnswerFeaturesSteps(candidates, answers, 4), changed = yield* consensusReplaceSteps(candidates, baseline.selected, features);
  return { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version }, highRecall: { replacements: changed.replacements, comparisons: features.comparisons } };
}

export function highRecallSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = HIGH_RECALL_POLICY, experiment: BlockExperiment = {}) {
  const steps = highRecallSampleSteps(candidates, answers, limit, policy, experiment);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}
