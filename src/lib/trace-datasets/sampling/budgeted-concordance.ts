import { type Candidate, type Policy } from './index';
import { CONCORDANCE_POLICY, concordancePreparedSteps } from './answer-concordance';
import { boundedProxyImproveSteps } from './budgeted-bounded-proxy';
import { type BlockExperiment } from './budgeted-priced-core';

export const CONCORDANCE_SEARCH_POLICY = Object.freeze({ ...CONCORDANCE_POLICY, version: 'trace-coverage-v6.25' });
export function* concordanceSearchSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = CONCORDANCE_SEARCH_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== CONCORDANCE_SEARCH_POLICY.version) throw new Error('INVALID_CONFIG');
  const prepared = yield* concordancePreparedSteps(candidates, answers, limit, { ...policy, version: CONCORDANCE_POLICY.version }, experiment), baseline = prepared.result;
  if (!prepared.features) return { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, concordanceSearch: { passes: 0, swaps: 0, coverageFloor: baseline.optimization.vocabulary, initialScore: null, finalScore: null } };
  const changed = yield* boundedProxyImproveSteps(candidates, baseline.selected, prepared.features, { tokenBudget: baseline.optimization.tokenBudget, distributionEnabled: baseline.optimization.distributionEnabled });
  return { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version, vocabulary: changed.vocabulary, coverageGap: baseline.optimization.coverageUpperBound - changed.vocabulary, tokens: changed.tokens, lengthTV: changed.lengthTV, taskTV: changed.taskTV, completeStopped: changed.proxy.swaps ? 'post_concordance_search' : baseline.optimization.completeStopped }, concordanceSearch: changed.proxy };
}
export function concordanceSearchSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = CONCORDANCE_SEARCH_POLICY, experiment: BlockExperiment = {}) { const steps = concordanceSearchSampleSteps(candidates, answers, limit, policy, experiment); let next = steps.next(); while (!next.done) next = steps.next(); return next.value; }
