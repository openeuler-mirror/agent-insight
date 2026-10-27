import { type Candidate, type Policy } from './index';
import { type AgreementFeatures, consensusReplaceSteps } from './answer-consensus';
import { type SharedAnswers } from './answer-shared';
import { SHARED_POLICY, sharedPreparedSteps } from './budgeted-shared';
import { type BlockExperiment } from './budgeted-priced-core';

export const GROUNDED_POLICY = Object.freeze({ ...SHARED_POLICY, version: 'trace-coverage-v6.18' });

export function* groundedFeaturesSteps(high: AgreementFeatures, records: SharedAnswers['records']): Generator<void, AgreementFeatures> {
  const df = new Map<string,number>(), weights = new Map<string,number>(); let work=0;
  for(const rows of high.groups.values()) for(const term of rows[0].lexical!.terms) { df.set(term,(df.get(term)||0)+1); if(++work%1024===0)yield; }
  for(const [term,n] of df) { weights.set(term,1+Math.log((high.groups.size+1)/(n+1))); if(++work%1024===0)yield; }
  const scores=new Map<string,number>(),groupScores=new Map<string,number>();
  for(const [inputKey,rows] of high.groups) {
    const terms=rows[0].lexical!.terms; let mass=0,total=0;
    for(const term of terms) { mass+=weights.get(term)!; if(++work%1024===0)yield; }
    const variants=records.get(inputKey)!;
    for(const variant of variants) {
      let covered=0;for(const term of terms) { if(variant.terms!.has(term))covered+=weights.get(term)!;if(++work%1024===0)yield; }
      const score=.75*high.scores.get(variant.keys[0])!+.25*(mass?covered/mass:0);total+=score;
      for(const key of variant.keys)scores.set(key,score);
    }
    groupScores.set(inputKey,total/variants.length); if(++work%64===0)yield;
  }
  return {groups:high.groups,scores,groupScores,comparisons:high.comparisons};
}

export function* groundedPreparedSteps(candidates:Candidate[], answers:ReadonlyMap<string,string>, limit:number, policy:Policy=GROUNDED_POLICY, experiment:BlockExperiment={}) {
  if(policy.version!==GROUNDED_POLICY.version)throw new Error('INVALID_CONFIG');
  const prepared=yield* sharedPreparedSteps(candidates,answers,limit,{...policy,version:SHARED_POLICY.version},experiment), baseline=prepared.result;
  if(!prepared.shared)return {result:{...baseline,optimization:{...baseline.optimization,requestedPolicy:policy.version},grounded:{replacements:0}},features:undefined};
  const features=yield* groundedFeaturesSteps(prepared.shared.high,prepared.shared.records),changed=yield* consensusReplaceSteps(candidates,baseline.selected,features);
  return {result:{...baseline,selected:changed.selected,counts:{...baseline.counts,behaviorReserveUsed:changed.selected.filter(s=>s.reason==='behavior').length,coveredCells:new Set(changed.selected.flatMap(s=>s.path.cells)).size},optimization:{...baseline.optimization,requestedPolicy:policy.version,effectivePolicy:policy.version},grounded:{replacements:changed.replacements}},features};
}
export function* groundedSampleSteps(candidates:Candidate[],answers:ReadonlyMap<string,string>,limit:number,policy:Policy=GROUNDED_POLICY,experiment:BlockExperiment={}) {return (yield* groundedPreparedSteps(candidates,answers,limit,policy,experiment)).result;}
export function groundedSample(candidates:Candidate[],answers:ReadonlyMap<string,string>,limit:number,policy:Policy=GROUNDED_POLICY,experiment:BlockExperiment={}) {const steps=groundedSampleSteps(candidates,answers,limit,policy,experiment);let next=steps.next();while(!next.done)next=steps.next();return next.value;}
