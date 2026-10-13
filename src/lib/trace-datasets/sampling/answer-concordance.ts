import { type Candidate, type Policy } from './index';
import { type AgreementFeatures, consensusReplaceSteps } from './answer-consensus';
import { type SharedAnswers } from './answer-shared';
import { BOUNDED_POLICY, boundedPreparedSteps } from './budgeted-bounded';
import { type BlockExperiment } from './budgeted-priced-core';

export const CONCORDANCE_POLICY = Object.freeze({ ...BOUNDED_POLICY, version: 'trace-coverage-v6.24' });

export function* concordanceFeaturesSteps(base: AgreementFeatures, high: AgreementFeatures, records: SharedAnswers['records']): Generator<void, AgreementFeatures> {
  const df=new Map<string,number>(),weights=new Map<string,number>();let work=0;
  for(const rows of high.groups.values())for(const term of rows[0].lexical!.terms){df.set(term,(df.get(term)||0)+1);if(++work%1024===0)yield;}
  for(const [term,n] of df){weights.set(term,1+Math.log((high.groups.size+1)/(n+1)));if(++work%1024===0)yield;}
  const scores=new Map<string,number>(),groupScores=new Map<string,number>();
  for(const [inputKey,variants] of records){
    const terms=high.groups.get(inputKey)![0].lexical!.terms;let mass=0,total=0;
    for(const term of terms){mass+=weights.get(term)!;if(++work%1024===0)yield;}
    for(const variant of variants){
      let covered=0;for(const term of terms){if(variant.terms!.has(term))covered+=weights.get(term)!;if(++work%1024===0)yield;}
      const c=high.scores.get(variant.keys[0])!,r=mass?covered/mass:0,denominator=.75*r+.25*c;
      const score=variants.length===1?base.scores.get(variant.keys[0])!:(denominator?c*r/denominator:0);
      total+=score;for(const key of variant.keys)scores.set(key,score);
      if(++work%64===0)yield;
    }
    groupScores.set(inputKey,total/variants.length);
  }
  return {groups:high.groups,scores,groupScores,comparisons:high.comparisons};
}
export function* concordancePreparedSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = CONCORDANCE_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== CONCORDANCE_POLICY.version) throw new Error('INVALID_CONFIG');
  const prepared = yield* boundedPreparedSteps(candidates, answers, limit, { ...policy, version: BOUNDED_POLICY.version }, experiment), baseline = prepared.result;
  if (!prepared.shared || !prepared.features) return { result: { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, concordance: { replacements: 0 } }, features: undefined };
  const features = yield* concordanceFeaturesSteps(prepared.features, prepared.shared.high, prepared.shared.records), changed = yield* consensusReplaceSteps(candidates, baseline.selected, features);
  return { result: { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version }, concordance: { replacements: changed.replacements } }, features };
}
export function* concordanceSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = CONCORDANCE_POLICY, experiment: BlockExperiment = {}) { return (yield* concordancePreparedSteps(candidates, answers, limit, policy, experiment)).result; }
export function concordanceSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = CONCORDANCE_POLICY, experiment: BlockExperiment = {}) { const steps = concordanceSampleSteps(candidates, answers, limit, policy, experiment); let next = steps.next(); while (!next.done) next = steps.next(); return next.value; }
