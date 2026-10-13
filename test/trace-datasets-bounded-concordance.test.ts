import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, lexicalFeatures, signature, POLICY, type Candidate, type Selection } from '../src/lib/trace-datasets/sampling';
import { directAnswerFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-direct';
import { pairedAnswerFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-paired';
import { groundedFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-grounded';
import { proxyImproveSteps } from '../src/lib/trace-datasets/sampling/budgeted-proxy';
import { boundedProxyImproveSteps } from '../src/lib/trace-datasets/sampling/budgeted-bounded-proxy';
import { proxySample } from '../src/lib/trace-datasets/sampling/budgeted-proxy';
import { boundedSample, boundedSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-bounded';
import { concordanceFeaturesSteps, concordanceSample, concordanceSampleSteps } from '../src/lib/trace-datasets/sampling/answer-concordance';
import { concordanceSearchSample, concordanceSearchSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-concordance';
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

test('bounded proxy search exactly preserves ties, floating scores, unique paths, long inputs and diagnostics',()=>{
  const base=fixture().rows[0];
  for(let seed=1;seed<=48;seed++){
    let x=seed;const next=()=>{x=(x*1664525+1013904223)>>>0;return x;};
    const rows=Array.from({length:30},(_,i)=>{const terms=[...new Set(Array.from({length:seed===48?1100:3+next()%12},(_,j)=>`t${seed===48?j+i:next()%35}`))];return {...base,key:`k${i}`,inputKey:`q${i}`,lexical:{terms,tokenCount:terms.length+next()%5},task:i%2?'coding':'unknown',paths:[{key:`p${i}`,cells:[`required${i%3}`],knownDimensions:1}]};});
    const initial=rows.slice(0,7).map(r=>({key:r.key,path:r.paths[0],reason:'initial'})),features=drain(directAnswerFeaturesSteps(rows,new Map(rows.map(r=>[r.key,'answer']))));
    for(const row of rows)features.scores.set(row.key,seed%2?(next()%5)/5:next()/2**32);
    const settings={tokenBudget:actual(rows,initial).tokens,distributionEnabled:true};
    assert.deepEqual(drain(boundedProxyImproveSteps(rows,initial,features,settings)),drain(proxyImproveSteps(rows,initial,features,settings)));
  }
});

test('bounded full pipeline exactly replays v6.19 including every diagnostic and fallback', () => {
  const { rows, answers } = fixture();
  for (const k of [1,12,40,500]) for (const budgetRatio of [1,1.1,1.2]) {
    const old = proxySample(rows,answers,k,undefined,{budgetRatio}), next = boundedSample(rows,answers,k,undefined,{budgetRatio});
    assert.deepEqual({...next,optimization:{...next.optimization,requestedPolicy:old.optimization.requestedPolicy,effectivePolicy:old.optimization.effectivePolicy}},old);
    assert.deepEqual(boundedSample([...rows].reverse(),answers,k,undefined,{budgetRatio}),next);
  }
});

test('concordance score matches weighted harmonic evidence, handles zero overlap, and deduplicates answers',()=>{
  const base=fixture().rows[0],answers=new Map([['a','alpha beta'],['b','alpha'],['copy','alpha beta'],['zero','unrelated']]);
  const rows=[...answers.keys()].map(key=>({...base,key,inputKey:'input',lexical:lexicalFeatures('alpha beta gamma delta')}));
  const paired=drain(pairedAnswerFeaturesSteps(rows,answers));for(const key of answers.keys())paired.high.scores.set(key,.4);
  const grounded=drain(groundedFeaturesSteps(paired.high,paired.records)),result=drain(concordanceFeaturesSteps(grounded,paired.high,paired.records));
  assert.equal(result.scores.get('a'),.4*.5/(.75*.5+.25*.4));assert.equal(result.scores.get('b'),.4*.25/(.75*.25+.25*.4));assert.equal(result.scores.get('zero'),0);
  assert.equal(result.scores.get('copy'),result.scores.get('a'));assert.equal(result.groupScores.get('input'),['a','b','zero'].reduce((n,k)=>n+result.scores.get(k)!,0)/3);
  for(const key of answers.keys())paired.high.scores.set(key,0);
  const zeros=drain(concordanceFeaturesSteps(grounded,paired.high,paired.records));assert.ok([...zeros.scores.values()].every(n=>n===0));
});

test('concordance leaves missing peer evidence at original score and preserves shared Unicode features',()=>{
  const base=fixture().rows[0],text='你好 café',rows=[{...base,key:'a',inputKey:'unicode',lexical:lexicalFeatures(text)},{...base,key:'duplicate',inputKey:'unicode',lexical:lexicalFeatures(text)}],answers=new Map([['a',text],['duplicate',text]]);
  const pair=drain(pairedAnswerFeaturesSteps(rows,answers)),grounded=drain(groundedFeaturesSteps(pair.high,pair.records)),before=structuredClone({pair,grounded});
  const result=drain(concordanceFeaturesSteps(grounded,pair.high,pair.records));assert.deepEqual({pair,grounded},before);assert.deepEqual(result.scores,grounded.scores);assert.equal(result.scores.get('a'),.25);
});

test('concordance answers and exchanges protect coverage, input counts, budget, tasks and real paths', () => {
  const {rows,answers}=fixture(), input=(key:string)=>rows.find(r=>r.key===key)!.inputKey;
  for(const k of [1,12,40,500])for(const budgetRatio of [1,1.1,1.2]){
    const a=boundedSample(rows,answers,k,undefined,{budgetRatio}),b=concordanceSample(rows,answers,k,undefined,{budgetRatio}),c=concordanceSearchSample(rows,answers,k,undefined,{budgetRatio});
    assert.deepEqual(b.selected.map(s=>input(s.key)),a.selected.map(s=>input(s.key)));assert.deepEqual(actual(rows,b.selected),actual(rows,a.selected));
    assert.equal(c.selected.length,b.selected.length);assert.equal(new Set(c.selected.map(s=>s.key)).size,c.selected.length);assert.equal(new Set(c.selected.map(s=>input(s.key))).size,new Set(b.selected.map(s=>input(s.key))).size);
    assert.deepEqual(actual(rows,c.selected),{vocabulary:c.optimization.vocabulary,tokens:c.optimization.tokens});
    if(b.optimization.feasible){assert.ok(c.optimization.vocabulary>=b.optimization.vocabulary);assert.ok(c.optimization.tokens<=c.optimization.tokenBudget);assert.ok(c.optimization.lengthTV<=c.optimization.lengthLimit+1e-9);assert.ok(c.optimization.taskTV<=c.optimization.taskLimit+1e-9);assert.ok(c.concordanceSearch.finalScore!>=c.concordanceSearch.initialScore!-1e-12);}
    const cells=new Set(c.selected.flatMap(s=>s.path.cells));for(const cell of b.selected.flatMap(s=>s.path.cells))assert.ok(cells.has(cell));
    for(const s of c.selected)assert.ok(rows.find(r=>r.key===s.key)!.paths.some(p=>p.key===s.path.key));
    assert.deepEqual(c,concordanceSearchSample([...rows].reverse(),answers,k,undefined,{budgetRatio}));
  }
});

test('concordance candidates retain cancellation, fallback and production default without input mutation', () => {
  const {rows,answers}=fixture(), snapshot=structuredClone(rows);
  for(const stepsFn of [boundedSampleSteps,concordanceSampleSteps,concordanceSearchSampleSteps]){const steps=stepsFn(rows,answers,12);assert.equal(steps.next().done,false);steps.return(undefined as never);}
  assert.deepEqual(rows,snapshot);assert.equal(POLICY.version,'trace-coverage-v4');
  assert.throws(()=>concordanceSearchSample(rows,answers,0),/INVALID_CONFIG/);
  assert.throws(()=>concordanceSearchSample(rows,answers,12,undefined,{budgetRatio:1.5}),/INVALID_CONFIG/);
  const base=rows[0], impossible=Array.from({length:31},(_,i)=>({...base,key:`impossible${i}`,inputKey:`impossible${i}`,task:i?'unknown':'rare-task',lexical:{terms:[`term${i}`],tokenCount:i?1:10000},paths:[{key:`path${i}`,cells:[],knownDimensions:0}]}));
  const texts=new Map(impossible.map(r=>[r.key,'reference answer'])), original=proxySample(impossible,texts,2);
  assert.equal(original.optimization.feasible,false);
  for(const sampler of [boundedSample,concordanceSample,concordanceSearchSample]){
    const result=sampler(impossible,texts,2);assert.equal(result.optimization.feasible,false);assert.equal(result.optimization.effectivePolicy,'trace-coverage-v4');assert.deepEqual(result.selected,original.selected);
  }
});
