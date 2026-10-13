import { type Candidate, type Policy } from './index';
import { SPARSE_POLICY, sparsePreparedSteps } from './budgeted-sparse';
import { consensusReplaceSteps, type AgreementFeatures } from './answer-consensus';
import { calibratedFeaturesSteps, representativeFeaturesSteps } from './answer-calibrated';
import { proxyImproveSteps } from './budgeted-proxy';
import { type BlockExperiment } from './budgeted-priced-core';

export const CALIBRATED_POLICIES=Object.freeze(Object.fromEntries([26,27,28,29,30,31].map(n=>[`V6${n}`,Object.freeze({...SPARSE_POLICY,version:`trace-coverage-v6.${n}`})]))) as Readonly<Record<string,Policy>>;
export function* calibratedSampleSteps(candidates:Candidate[],answers:ReadonlyMap<string,string>,limit:number,policy:Policy=CALIBRATED_POLICIES.V626,experiment:BlockExperiment={}){
  if(!Object.values(CALIBRATED_POLICIES).some(p=>p.version===policy.version))throw new Error('INVALID_CONFIG');
  const round=Number(policy.version.split('.').at(-1));
  const prepared=yield* sparsePreparedSteps(candidates,answers,limit,{...policy,version:SPARSE_POLICY.version},experiment);
  const base=prepared.result;
  if(round===26)return base;
  const mode=round<=28?'discount':'length';
  if(!prepared.shared||!prepared.features)return {...base,optimization:{...base.optimization,requestedPolicy:policy.version},calibration:{mode,replacements:0}};
  let features=yield* calibratedFeaturesSteps(mode,prepared.features,prepared.shared.high,prepared.shared.records);
  const changed=yield* consensusReplaceSteps(candidates,base.selected,features);
  let result={...base,selected:changed.selected,counts:{...base.counts,behaviorReserveUsed:changed.selected.filter(s=>s.reason==='behavior').length,coveredCells:new Set(changed.selected.flatMap(s=>s.path.cells)).size},optimization:{...base.optimization,requestedPolicy:policy.version,effectivePolicy:policy.version},calibration:{mode,replacements:changed.replacements}};
  const exchange=function*(input:typeof result,features:AgreementFeatures){
    const changed=yield* proxyImproveSteps(candidates,input.selected,features,{tokenBudget:input.optimization.tokenBudget,distributionEnabled:input.optimization.distributionEnabled});
    return {...input,selected:changed.selected,counts:{...input.counts,behaviorReserveUsed:changed.selected.filter(s=>s.reason==='behavior').length,coveredCells:new Set(changed.selected.flatMap(s=>s.path.cells)).size},optimization:{...input.optimization,vocabulary:changed.vocabulary,coverageGap:input.optimization.coverageUpperBound-changed.vocabulary,tokens:changed.tokens,lengthTV:changed.lengthTV,taskTV:changed.taskTV,completeStopped:changed.proxy.swaps?'post_calibrated_search':input.optimization.completeStopped},calibrationSearch:changed.proxy};
  };
  if(round===28||round>=30){const searched=yield* exchange(result,features);if(round!==31)return searched;result=searched;features=yield* representativeFeaturesSteps(candidates,features);const representative=yield* exchange(result,features);return {...representative,calibrationSearch:searched.calibrationSearch,representativeSearch:representative.calibrationSearch};}
  return result;
}
export function calibratedSample(candidates:Candidate[],answers:ReadonlyMap<string,string>,limit:number,policy:Policy=CALIBRATED_POLICIES.V626,experiment:BlockExperiment={}){const steps=calibratedSampleSteps(candidates,answers,limit,policy,experiment);let n=steps.next();while(!n.done)n=steps.next();return n.value;}
