import { type AgreementFeatures } from './answer-consensus';
import { type SharedAnswers } from './answer-shared';

export function* groundedFeaturesSteps(high: AgreementFeatures, records: SharedAnswers['records']): Generator<void, AgreementFeatures> {
  const df = new Map<string,number>(), weights = new Map<string,number>(); let work=0;
  for(const rows of high.groups.values()) for(const term of rows[0].lexical!.terms) { df.set(term,(df.get(term)||0)+1); if(++work%1024===0)yield; }
  for(const [term,n] of df) { weights.set(term,1+Math.log((high.groups.size+1)/(n+1))); if(++work%1024===0)yield; }
  const scores=new Map<string,number>(),groupScores=new Map<string,number>();
  for(const [inputKey,rows] of high.groups) {
    const terms=rows[0].lexical!.terms; let mass=0,total=0;
    for(const term of terms) { mass+=weights.get(term)!; if(++work%1024===0)yield; }
    const variants=records.get(inputKey)!;
    const positions=variants.some(v=>v.terms!.size<terms.length)?new Map(terms.map((term,i)=>[term,i])):undefined;
    for(const variant of variants) {
      let covered=0;
      if (positions && variant.terms!.size < terms.length) {
        const matches:number[]=[];
        for(const term of variant.terms!){const i=positions.get(term);if(i!==undefined)matches.push(i);if(++work%1024===0)yield;}
        matches.sort((a,b)=>a-b);
        for(const i of matches){covered+=weights.get(terms[i])!;if(++work%1024===0)yield;}
      } else for(const term of terms){if(variant.terms!.has(term))covered+=weights.get(term)!;if(++work%1024===0)yield;}
      const score=.75*high.scores.get(variant.keys[0])!+.25*(mass?covered/mass:0);total+=score;
      for(const key of variant.keys)scores.set(key,score);
    }
    groupScores.set(inputKey,total/variants.length); if(++work%64===0)yield;
  }
  return {groups:high.groups,scores,groupScores,comparisons:high.comparisons};
}

