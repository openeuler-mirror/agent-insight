import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const [dataRoot, baselineRoot, resultRoot, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: verify-evidence-support.ts <data> <v4> <results> <output>');
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const normal = (v: string) => v.replace(/\r\n?/g,'\n').normalize('NFC');
const tokens = (v: string) => v.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu) || [];
const mean = (v: number[]) => v.reduce((a,b)=>a+b,0)/v.length;
type Row = { key:string; input:string; inputKey:string; text:string };
const sources: any[] = []; let scenarios=0,positions=0,changedPositions=0;
for (const name of ['WildChat','Dolly','NoRobots','OASST2','ShareGPT4','UltraChat','HelpSteer2','SummarizeFeedback']) {
 const bytes=fs.readFileSync(path.join(dataRoot,`${name}.json`)),raw=JSON.parse(bytes.toString()),results=fs.readFileSync(path.join(resultRoot,`${name}.json`)),report=JSON.parse(results.toString()),baseline=JSON.parse(fs.readFileSync(path.join(baselineRoot,`${name}.json`),'utf8'));
 assert.equal(sha(bytes),report.dataSha256);assert.ok(report.finishedAt);
 sources.push({dataset:name,dataSha256:sha(bytes),resultsSha256:sha(results)});
 const strata=new Map<string,Map<string,Row>>();
 for(const r of raw){if(!r.input.trim()||!r.reference_output.trim())continue;const stratum=name==='SummarizeFeedback'?`${r.domain}/${r.split}`:'all';if(!strata.has(stratum))strata.set(stratum,new Map());const input=normal(r.input),text=normal(r.reference_output),key=sha(JSON.stringify([input,text]));strata.get(stratum)!.set(key,{key,input,text,inputKey:sha(JSON.stringify([input]))});}
 const scores=new Map<string,Map<string,[number,number]>>();
 for(const scenario of report.scenarios){
  const id=`${scenario.stratum}:${scenario.population}`;
  if(scores.has(id))continue;
  const e=baseline.experiments.filter((e:any)=>e.stratum===scenario.stratum&&e.population===scenario.population).sort((a:any,b:any)=>Math.abs(a.requestedPool-5000)-Math.abs(b.requestedPool-5000))[0];
  const groups=new Map<string,Row[]>();for(const key of e.poolKeys){const row=strata.get(scenario.stratum)!.get(key)!;assert.ok(row);if(!groups.has(row.inputKey))groups.set(row.inputKey,[]);groups.get(row.inputKey)!.push(row);}
  const variants=new Map<string,{keys:string[];words:string[];terms:Set<string>;grams:Set<string>;count:number}[]>(),inputTerms=new Map<string,Set<string>>(),answerDf=new Map<string,number>(),inputDf=new Map<string,number>();
  for(const [key,rows] of groups){
   const input=new Set(tokens(rows[0].input));inputTerms.set(key,input);for(const term of input)inputDf.set(term,(inputDf.get(term)||0)+1);
   const distinct=new Map<string,{keys:string[];words:string[];terms:Set<string>;grams:Set<string>;count:number}>();
   for(const row of [...rows].sort((a,b)=>a.key.localeCompare(b.key))){const id=sha(JSON.stringify([row.text])),old=distinct.get(id);if(old){old.keys.push(row.key);continue;}const words=tokens(row.text),grams=new Set<string>();for(let i=1;i<words.length;i++)grams.add(words[i-1]+'\0'+words[i]);distinct.set(id,{keys:[row.key],words,terms:new Set(words),grams,count:Math.max(0,words.length-1)});}
   const values=[...distinct.values()];variants.set(key,values);const union=new Set(values.flatMap(v=>[...v.terms]));for(const term of union)answerDf.set(term,(answerDf.get(term)||0)+1);
  }
  const weight=(df:Map<string,number>,term:string)=>1+Math.log((groups.size+1)/(df.get(term)!+1));const values=new Map<string,[number,number]>();
  for(const [inputKey,rows] of variants){
   const masses=rows.map(r=>[...r.terms].reduce((n,t)=>n+weight(answerDf,t),0)),input=inputTerms.get(inputKey)!,inputMass=[...input].reduce((n,t)=>n+weight(inputDf,t),0),sizes=rows.map(r=>r.words.length).sort((a,b)=>a-b),mid=Math.floor(sizes.length/2),median=sizes.length%2?sizes[mid]:(sizes[mid-1]+sizes[mid])/2,hasEvidence=rows.some(r=>r.count>0);
   for(let i=0;i<rows.length;i++){
    let f4=0,p=0,support=0;
    for(let j=0;j<rows.length;j++){if(i===j)continue;const a=rows[i],b=rows[j],[small,large]=a.terms.size<=b.terms.size?[a.terms,b.terms]:[b.terms,a.terms];let intersection=0;for(const t of small)if(large.has(t))intersection+=weight(answerDf,t);const d4=16*masses[j]+masses[i];f4+=d4?17*intersection/d4:0;let pairs=0;for(const gram of a.grams)if(b.grams.has(gram))pairs++;const d2=4*b.grams.size+a.grams.size;p+=d2?5*pairs/d2:0;if(++support===32)break;}
    const recall=inputMass?[...input].reduce((n,t)=>n+(rows[i].terms.has(t)?weight(inputDf,t):0),0)/inputMass:0;
    const grounded=.75*(support?f4/support:0)+.25*recall,length=rows.length===1?grounded:.9*grounded+.1*Math.exp(-Math.abs(Math.log((rows[i].words.length+1)/(median+1))));
    const informative=rows.length>1&&hasEvidence,phrase=informative?.8*length+.2*(support?p/support:0):length,repeat=informative?.9*length+.1*(rows[i].count?rows[i].grams.size/rows[i].count:0):length;
    for(const key of rows[i].keys)values.set(key,[phrase,repeat]);
   }
  }
  scores.set(id,values);
 }
 for(const s of report.scenarios)for(const suffix of ['', '_1','_1.2']){
  const a=s.methods['V632'+suffix],b=s.methods['V637'+suffix];if(!b)continue;scenarios++;assert.equal(a.selected.length,b.selected.length);const features=scores.get(`${s.stratum}:${s.population}`)!;
  for(let i=0;i<a.selected.length;i++){positions++;const x=features.get(a.selected[i])!,y=features.get(b.selected[i])!;assert.ok(x&&y);assert.ok(y[0]>=x[0]-1e-12&&y[1]>=x[1]-1e-12,`${name}/${s.seed}/${suffix}: component decrease`);if(a.selected[i]!==b.selected[i]){changedPositions++;assert.ok(mean(y)>mean(x),`${name}: no strict improvement`);}}
 }
}
assert.equal(scenarios,99);
fs.writeFileSync(output,JSON.stringify({passed:true,scenarios,positions,changedPositions,rule:'Both independently recomputed phrase/repetition calibrated scores are nondecreasing; changed positions strictly improve their mean. No labels read; all baseline-to-final positions and budget variants checked.',sources,scriptSha256:sha(fs.readFileSync('scripts/trace-datasets/verify-evidence-support.ts'))},null,2));
console.log(JSON.stringify({passed:true,scenarios,positions,changedPositions}));
