import { type Candidate, type Policy } from './index';
import { PRICED_CORE_POLICY, pricedCoreSampleSteps, type BlockExperiment } from './budgeted-priced-core';
import { pairedAnswerFeaturesSteps } from './answer-sparse-paired';
import { consensusReplaceSteps } from './answer-consensus';
import { prunedCrossingSteps } from './budgeted-pruned-crossing';

import { groundedFeaturesSteps } from './answer-sparse-grounded';
import { proxyImproveSteps } from './budgeted-proxy';

export const SPARSE_POLICY = Object.freeze({ ...PRICED_CORE_POLICY, version: 'trace-coverage-v6.26' });

export function* sparsePreparedSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = SPARSE_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== SPARSE_POLICY.version) throw new Error('INVALID_CONFIG');
  const baseline = yield* pricedCoreSampleSteps(candidates, limit, { ...policy, version: PRICED_CORE_POLICY.version }, experiment);
  const emptyCrossing = { trajectories: 0, steps: 0, negativeMoves: 0, plateauMoves: 0, aspirations: 0, bestUpdates: 0, overBudgetSteps: 0, internalBudgetRatio: 1.25 };
  if (!baseline.optimization.feasible) return { result: { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, weighted: { replacements: 0, comparisons: 0 }, crossing: emptyCrossing, highRecall: { replacements: 0, comparisons: 0 }, grounded: { replacements: 0 }, proxy: { passes: 0, swaps: 0, coverageFloor: baseline.optimization.vocabulary, initialScore: null, finalScore: null } }, shared: undefined, features: undefined };
  const shared = yield* pairedAnswerFeaturesSteps(candidates, answers);
  const first = yield* consensusReplaceSteps(candidates, baseline.selected, shared.recall);
  const costBound = candidates.map(c => c.lexical!.tokenCount).sort((a,b) => a-b).slice(0, baseline.selected.length).reduce((n,v) => n+v,0);
  const changed = baseline.optimization.vocabulary === baseline.optimization.coverageUpperBound && baseline.optimization.tokens === costBound ? { selected: first.selected, vocabulary: baseline.optimization.vocabulary, tokens: baseline.optimization.tokens, lengthTV: baseline.optimization.lengthTV, taskTV: baseline.optimization.taskTV, crossing: emptyCrossing } : yield* prunedCrossingSteps(candidates, first.selected, shared.recall, { seed: policy.seed, tokenBudget: baseline.optimization.tokenBudget, distributionEnabled: baseline.optimization.distributionEnabled });
  const last = yield* consensusReplaceSteps(candidates, changed.selected, shared.high);
  const result = { ...baseline, selected: last.selected, counts: { ...baseline.counts, behaviorReserveUsed: last.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(last.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version, vocabulary: changed.vocabulary, coverageGap: baseline.optimization.coverageUpperBound - changed.vocabulary, tokens: changed.tokens, lengthTV: changed.lengthTV, taskTV: changed.taskTV, completeStopped: changed.crossing.bestUpdates ? 'post_priced_crossing' : baseline.optimization.completeStopped }, weighted: { replacements: first.replacements, comparisons: shared.recall.comparisons }, crossing: changed.crossing, highRecall: { replacements: last.replacements, comparisons: shared.high.comparisons } };
  const features = yield* groundedFeaturesSteps(shared.high, shared.records);
  const grounded = yield* consensusReplaceSteps(candidates, result.selected, features);
  const proxy = yield* proxyImproveSteps(candidates, grounded.selected, features, { tokenBudget: result.optimization.tokenBudget, distributionEnabled: result.optimization.distributionEnabled });
  return { result: { ...result, selected: proxy.selected, counts: { ...result.counts, behaviorReserveUsed: proxy.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(proxy.selected.flatMap(s => s.path.cells)).size }, optimization: { ...result.optimization, vocabulary: proxy.vocabulary, coverageGap: result.optimization.coverageUpperBound - proxy.vocabulary, tokens: proxy.tokens, lengthTV: proxy.lengthTV, taskTV: proxy.taskTV, completeStopped: proxy.proxy.swaps ? 'post_proxy_search' : result.optimization.completeStopped }, grounded: { replacements: grounded.replacements }, proxy: proxy.proxy }, shared, features };
}

export function* sparseSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string,string>, limit:number, policy:Policy=SPARSE_POLICY, experiment:BlockExperiment={}) {
  return (yield* sparsePreparedSteps(candidates,answers,limit,policy,experiment)).result;
}
export function sparseSample(candidates: Candidate[], answers: ReadonlyMap<string,string>, limit:number, policy:Policy=SPARSE_POLICY, experiment:BlockExperiment={}) {
  const steps=sparseSampleSteps(candidates,answers,limit,policy,experiment);let next=steps.next();while(!next.done)next=steps.next();return next.value;
}
