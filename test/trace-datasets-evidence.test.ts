import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,lexicalFeatures,signature,POLICY,type Candidate,type Selection} from '../src/lib/trace-datasets/sampling';
import {pairedAnswerFeaturesSteps as originalPaired} from '../src/lib/trace-datasets/sampling/answer-sparse-paired';
import {pairedAnswerFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-memo-paired';
import {groundedFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-sparse-grounded';
import {calibratedFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-calibrated';
import {calibratedSample,CALIBRATED_POLICIES} from '../src/lib/trace-datasets/sampling/budgeted-calibrated';
import {phraseFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-phrase';
import {proxyImproveSteps} from '../src/lib/trace-datasets/sampling/budgeted-proxy';
import {supportedImproveSteps} from '../src/lib/trace-datasets/sampling/budgeted-supported-proxy';
import {evidenceSample,evidenceSampleSteps,supportedReplaceSteps,EVIDENCE_POLICIES as policies} from '../src/lib/trace-datasets/sampling/budgeted-evidence';
function drain<T>(steps: Generator<void, T>): T { let n = steps.next(); while (!n.done) n = steps.next(); return n.value; }
function fixture() {
  const rows: Candidate[] = [], answers = new Map<string, string>();
  for (let i = 0; i < 32; i++) {
    const input = `question ${i} ` + Array.from({ length: 8 + 5 * i }, (_, j) => `word${(i * 13 + j) % 190}`).join(' ');
    for (let v = 0; v < 1 + i % 3; v++) {
      const answer = v ? `answer ${i} with explanation detail extra ${v}` : `answer ${i}`, key = hash([input, answer]); answers.set(key, answer);
      rows.push({ key, inputKey: hash([input]), lexical: lexicalFeatures(input), signature: signature(input), task: ['coding', 'writing', 'unknown'][i % 3], paths: [{ key: `${key}:a`, cells: [`tool:${i % 4}`], knownDimensions: 1 }, { key: `${key}:b`, cells: ['common'], knownDimensions: 1 }] });
    }
  }
  return { rows, answers };
}
function actual(rows: Candidate[], selected: Selection[]) {
  const byKey = new Map(rows.map(r => [r.key, r]));
  return { vocabulary: new Set(selected.flatMap(s => byKey.get(s.key)!.lexical!.terms)).size, tokens: selected.reduce((n, s) => n + byKey.get(s.key)!.lexical!.tokenCount, 0) };
}


test('memoized intersections exactly preserve directed summation, the 32 peer cap and duplicate answer evidence',()=>{
 const {rows,answers}=fixture();assert.deepEqual(drain(pairedAnswerFeaturesSteps(rows,answers)),drain(originalPaired(rows,answers)));
 const large=Array.from({length:41},(_,i)=>({...rows[0],key:String(i),inputKey:'one'})),texts=new Map(large.map((r,i)=>[r.key,Array.from({length:2+i%11},(_,j)=>`term${(i+j)%13}`).reverse().join(' ')]));
 assert.deepEqual(drain(pairedAnswerFeaturesSteps(large,texts)),drain(originalPaired(large,texts)));
});
test('v632 exactly replays the full v630 result across budgets and requested counts',()=>{
 const {rows,answers}=fixture();for(const k of [1,12,40,500])for(const budgetRatio of [1,1.1,1.2]){
  const a=calibratedSample(rows,answers,k,CALIBRATED_POLICIES.V630,{budgetRatio}),b=evidenceSample(rows,answers,k,policies.V632,{budgetRatio});
  assert.deepEqual({...b,optimization:{...b.optimization,requestedPolicy:a.optimization.requestedPolicy,effectivePolicy:a.optimization.effectivePolicy}},a);
 }
});
test('phrase F2 uses ordered adjacent tokens with directional peer mass and deduplicated supporting answers',()=>{
 const row=fixture().rows[0],texts=new Map([['a','A b c'],['b','a b'],['copy','A b c']]),rows=[...texts.keys()].map(key=>({...row,key,inputKey:'q'}));
 const p=drain(pairedAnswerFeaturesSteps(rows,texts));for(const key of texts.keys())p.high.scores.set(key,.4);
 const f=drain(phraseFeaturesSteps('phrase',p.high,p.records));assert.ok(Math.abs(f.primary.scores.get('a')!-(.32+.2*5/6))<1e-14);assert.ok(Math.abs(f.primary.scores.get('b')!-(.32+.2*5/9))<1e-14);assert.equal(f.primary.scores.get('a'),f.primary.scores.get('copy'));assert.equal(f.primary.comparisons,2);
});
test('repetition density counts occurrences, retains Unicode token order and does not count duplicate answers twice',()=>{
 const row=fixture().rows[0],texts=new Map([['a','a b a b'],['b','你 好 世 界'],['copy','a b a b']]),rows=[...texts.keys()].map(key=>({...row,key,inputKey:'q'}));
 const p=drain(pairedAnswerFeaturesSteps(rows,texts));for(const key of texts.keys())p.high.scores.set(key,.4);
 const f=drain(phraseFeaturesSteps('repeat',p.high,p.records));assert.ok(Math.abs(f.primary.scores.get('a')!-(.36+.1*2/3))<1e-14);assert.ok(Math.abs(f.primary.scores.get('b')!-.46)<1e-14);assert.equal(f.primary.scores.get('a'),f.primary.scores.get('copy'));assert.equal(f.primary.comparisons,0);
});
test('single-answer and no-bigram groups preserve the original scores for every evidence mode',()=>{
 const row=fixture().rows[0],texts=new Map([['a','single answer'],['b','!!!'],['c','你好']]),rows=[{...row,key:'a',inputKey:'q'},{...row,key:'b',inputKey:'q2'},{...row,key:'c',inputKey:'q3'}];
 const p=drain(pairedAnswerFeaturesSteps(rows,texts));for(const mode of ['phrase','repeat','dual'] as const)assert.deepEqual(drain(phraseFeaturesSteps(mode,p.high,p.records)).primary.scores,p.high.scores);
 const emptyRows=rows.slice(0,2).map(r=>({...r,inputKey:'q'})),empty=drain(pairedAnswerFeaturesSteps(emptyRows,new Map([['a','one'],['b','...']])));for(const mode of ['phrase','repeat','dual'] as const)assert.deepEqual(drain(phraseFeaturesSteps(mode,empty.high,empty.records)).primary.scores,empty.high.scores);
});
test('dual support vetoes a higher mean with one declining component; permissive exchange replays original and vetoed exchange keeps selections',()=>{
 const {rows,answers}=fixture(),p=drain(pairedAnswerFeaturesSteps(rows,answers)),features=drain(groundedFeaturesSteps(p.high,p.records)),base=evidenceSample(rows,answers,12);
 const settings=base.optimization;
 assert.deepEqual(drain(supportedImproveSteps(rows,base.selected,features,settings,()=>true)),drain(proxyImproveSteps(rows,base.selected,features,settings)));
 assert.deepEqual(drain(supportedImproveSteps(rows,base.selected,features,settings,()=>false)).selected,base.selected);
 const pair=[{...rows[0],key:'old',inputKey:'one'},{...rows[0],key:'bad',inputKey:'one'}],f={groups:new Map([['one',pair]]),scores:new Map([['old',.4],['bad',.6]]),groupScores:new Map([['one',.5]]),comparisons:0},pick={key:'old',path:pair[0].paths[0],reason:'test'};
 const a=new Map([['old',.4],['bad',.3]]),b=new Map([['old',.4],['bad',.9]]),supports=(old:string,next:string)=>a.get(next)!>=a.get(old)!&&b.get(next)!>=b.get(old)!;
 assert.deepEqual(drain(supportedReplaceSteps(pair,[pick],f,supports)).selected,[pick]);a.set('bad',.5);assert.equal(drain(supportedReplaceSteps(pair,[pick],f,supports)).selected[0].key,'bad');
});
test('six evidence branches preserve feasible constraints, real paths, counts, coverage and deterministic input ordering',()=>{
 const {rows,answers}=fixture(),byKey=new Map(rows.map(r=>[r.key,r])),inputs=(s:Selection[])=>s.map(p=>byKey.get(p.key)!.inputKey),parents={V633:'V632',V634:'V633',V635:'V632',V636:'V635',V637:'V632'};
 const p=drain(pairedAnswerFeaturesSteps(rows,answers)),g=drain(groundedFeaturesSteps(p.high,p.records)),l=drain(calibratedFeaturesSteps('length',g,p.high,p.records)),dual=drain(phraseFeaturesSteps('dual',l,p.records));
 for(const k of [1,12,40,500])for(const budgetRatio of [1,1.1,1.2]){
  const runs=new Map(Object.entries(policies).map(([v,policy])=>[v,evidenceSample(rows,answers,k,policy,{budgetRatio})]));
  for(const [v,parent] of Object.entries(parents)){
   const a=runs.get(parent)!,b=runs.get(v)!;assert.equal(a.selected.length,b.selected.length);assert.equal(new Set(b.selected.map(s=>s.key)).size,b.selected.length);assert.equal(new Set(inputs(b.selected)).size,new Set(inputs(a.selected)).size);assert.deepEqual(actual(rows,b.selected),{vocabulary:b.optimization.vocabulary,tokens:b.optimization.tokens});
   if(v==='V633'||v==='V635'){assert.deepEqual(inputs(b.selected),inputs(a.selected));assert.deepEqual(actual(rows,b.selected),actual(rows,a.selected));}
   if(a.optimization.feasible){assert.ok(b.optimization.vocabulary>=a.optimization.vocabulary);assert.ok(b.optimization.tokens<=b.optimization.tokenBudget);assert.ok(b.optimization.lengthTV<=b.optimization.lengthLimit+1e-9);assert.ok(b.optimization.taskTV<=b.optimization.taskLimit+1e-9);}
   const cells=new Set(b.selected.flatMap(s=>s.path.cells));for(const c of a.selected.flatMap(s=>s.path.cells))assert.ok(cells.has(c));for(const s of b.selected)assert.ok(byKey.get(s.key)!.paths.some(p=>p.key===s.path.key));
   if(v==='V637')for(let i=0;i<a.selected.length;i++)for(const f of [dual.phrase,dual.repeat])assert.ok(f.scores.get(b.selected[i].key)!>=f.scores.get(a.selected[i].key)!);
   assert.deepEqual(evidenceSample([...rows].reverse(),answers,k,policies[v],{budgetRatio}),b);
  }
 }
});
test('evidence samplers retain cancellation, invalid inputs, infeasible v4 fallback and production default',()=>{
 const {rows,answers}=fixture(),before=structuredClone(rows);for(const p of Object.values(policies)){const g=evidenceSampleSteps(rows,answers,12,p);assert.equal(g.next().done,false);g.return(undefined as never);}assert.deepEqual(rows,before);assert.equal(POLICY.version,'trace-coverage-v4');assert.throws(()=>evidenceSample(rows,answers,0),/INVALID_CONFIG/);assert.throws(()=>evidenceSample(rows,answers,12,{...policies.V632,version:'bad'}),/INVALID_CONFIG/);
 const bad=Array.from({length:31},(_,i)=>({...rows[0],key:`i${i}`,inputKey:`i${i}`,task:i?'unknown':'rare-task',lexical:{terms:[`t${i}`],tokenCount:i?1:10000},paths:[{key:`p${i}`,cells:[],knownDimensions:0}]})),texts=new Map(bad.map(r=>[r.key,'reference answer'])),original=calibratedSample(bad,texts,2,CALIBRATED_POLICIES.V630);assert.equal(original.optimization.feasible,false);for(const p of Object.values(policies)){const r=evidenceSample(bad,texts,2,p);assert.equal(r.optimization.effectivePolicy,'trace-coverage-v4');assert.deepEqual(r.selected,original.selected);}
});
