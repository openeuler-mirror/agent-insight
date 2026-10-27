import { lexicalSteps, type Candidate } from './index';
import { type AgreementFeatures } from './answer-consensus';
import { type SharedAnswers } from './answer-shared';

export function* calibratedFeaturesSteps(mode:'discount'|'length', base:AgreementFeatures, high:AgreementFeatures, records:SharedAnswers['records']):Generator<void,AgreementFeatures> {
  const df=new Map<string,number>(),weights=new Map<string,number>(),inputDf=new Map<string,number>(),inputWeights=new Map<string,number>();let work=0;
  if(mode==='discount'){
    for(const rows of base.groups.values())for(const term of rows[0].lexical!.terms){inputDf.set(term,(inputDf.get(term)||0)+1);if(++work%1024===0)yield;}
    for(const [term,n] of inputDf){inputWeights.set(term,1+Math.log((base.groups.size+1)/(n+1)));if(++work%1024===0)yield;}
    for(const variants of records.values()){
      const union=new Set<string>();for(const v of variants)for(const term of v.terms!){union.add(term);if(++work%1024===0)yield;}
      for(const term of union){df.set(term,(df.get(term)||0)+1);if(++work%1024===0)yield;}
    }
    for(const [term,n] of df){weights.set(term,1+Math.log((records.size+1)/(n+1)));if(++work%1024===0)yield;}
  }
  const scores=new Map<string,number>(),groupScores=new Map<string,number>();let comparisons=0;
  for(const [inputKey,variants] of records){
    const values:number[]=[];
    if(variants.length===1){const score=base.scores.get(variants[0].keys[0])!;for(const key of variants[0].keys)scores.set(key,score);groupScores.set(inputKey,score);continue;}
    const input=new Set(base.groups.get(inputKey)![0].lexical!.terms),mass:number[]=[],lengths:number[]=[];
    if(mode==='discount')for(const variant of variants){let m=0;for(const term of variant.terms!){m+=weights.get(term)!*(input.has(term)?.25:1);if(++work%1024===0)yield;}mass.push(m);}
    else for(const variant of variants)lengths.push((yield* lexicalSteps(variant.text)).tokenCount);
    const ordered=[...lengths].sort((a,b)=>a-b),mid=Math.floor(ordered.length/2),median=mode==='length'?(ordered.length%2?ordered[mid]:(ordered[mid-1]+ordered[mid])/2):0;
    for(let i=0;i<variants.length;i++){
      const variant=variants[i],key=variant.keys[0];let score:number;
      if(mode==='length')score=.9*base.scores.get(key)!+.1*Math.exp(-Math.abs(Math.log((lengths[i]+1)/(median+1))));
      else{
        let sum=0,support=0;
        for(let j=0;j<variants.length;j++){
          if(i===j)continue;const a=variant.terms!,b=variants[j].terms!;const [small,large]=a.size<=b.size?[a,b]:[b,a];let intersection=0;
          for(const term of small){if(large.has(term))intersection+=weights.get(term)!*(input.has(term)?.25:1);if(++work%1024===0)yield;}
          const denominator=16*mass[j]+mass[i];sum+=denominator?17*intersection/denominator:0;comparisons++;
          if(++support===32)break;
        }
        let inputMass=0,covered=0;for(const term of input){inputMass+=inputWeights.get(term)!;if(variant.terms!.has(term))covered+=inputWeights.get(term)!;if(++work%1024===0)yield;}
        const recall=inputMass?covered/inputMass:0;
        score=.75*(support?sum/support:0)+.25*recall;
      }
      values.push(score);for(const k of variant.keys)scores.set(k,score);if(++work%64===0)yield;
    }
    groupScores.set(inputKey,values.reduce((n,v)=>n+v,0)/values.length);
  }
  return {groups:base.groups,scores,groupScores,comparisons:mode==='discount'?comparisons:base.comparisons};
}

export function* representativeFeaturesSteps(candidates:Candidate[],base:AgreementFeatures):Generator<void,AgreementFeatures>{
  const df=new Map<string,number>();let work=0;
  for(const rows of base.groups.values())for(const term of rows[0].lexical!.terms){df.set(term,(df.get(term)||0)+1);if(++work%1024===0)yield;}
  const scores=new Map<string,number>(),groupScores=new Map<string,number>(),denominator=Math.log1p(base.groups.size);
  for(const [inputKey,rows] of base.groups){
    const terms=rows[0].lexical!.terms;let sum=0;
    for(const term of terms){sum+=Math.log1p(df.get(term)!)/denominator;if(++work%1024===0)yield;}
    const typical=terms.length?sum/terms.length:0;
    for(const row of rows)scores.set(row.key,.75*base.scores.get(row.key)!+.25*typical);
    groupScores.set(inputKey,.75*base.groupScores.get(inputKey)!+.25*typical);if(++work%64===0)yield;
  }
  if(scores.size!==candidates.length)throw new Error('SOURCE_CORRUPT');
  return {groups:base.groups,scores,groupScores,comparisons:base.comparisons};
}
