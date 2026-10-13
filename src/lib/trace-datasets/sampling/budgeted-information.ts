import { type Candidate, type Policy } from './index';
import { INFORMATION_POLICY, informationPreparedSteps } from './answer-information';
import { proxyImproveSteps } from './budgeted-proxy';
import { type BlockExperiment } from './budgeted-priced-core';

export const INFORMATION_SEARCH_POLICY = Object.freeze({ ...INFORMATION_POLICY, version: 'trace-coverage-v6.22' });
export function* informationSearchSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = INFORMATION_SEARCH_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== INFORMATION_SEARCH_POLICY.version) throw new Error('INVALID_CONFIG');
  const prepared = yield* informationPreparedSteps(candidates, answers, limit, { ...policy, version: INFORMATION_POLICY.version }, experiment), baseline = prepared.result;
  if (!prepared.features) return { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, informationSearch: { passes: 0, swaps: 0, coverageFloor: baseline.optimization.vocabulary, initialScore: null, finalScore: null } };
  const changed = yield* proxyImproveSteps(candidates, baseline.selected, prepared.features, { tokenBudget: baseline.optimization.tokenBudget, distributionEnabled: baseline.optimization.distributionEnabled });
  return { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version, vocabulary: changed.vocabulary, coverageGap: baseline.optimization.coverageUpperBound - changed.vocabulary, tokens: changed.tokens, lengthTV: changed.lengthTV, taskTV: changed.taskTV, completeStopped: changed.proxy.swaps ? 'post_information_search' : baseline.optimization.completeStopped }, informationSearch: changed.proxy };
}
export function informationSearchSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = INFORMATION_SEARCH_POLICY, experiment: BlockExperiment = {}) { const steps = informationSearchSampleSteps(candidates, answers, limit, policy, experiment); let next = steps.next(); while (!next.done) next = steps.next(); return next.value; }
