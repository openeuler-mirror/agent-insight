import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, lexicalFeatures, signature, POLICY, type Candidate, type Selection } from '../src/lib/trace-datasets/sampling';
import { directAnswerFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-direct';
import { pairedAnswerFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-paired';
import { groundedFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-grounded';
import { prunedCrossingSteps } from '../src/lib/trace-datasets/sampling/budgeted-pruned-crossing';
import { incrementalCrossingSteps } from '../src/lib/trace-datasets/sampling/budgeted-incremental-crossing';
import { proxySample } from '../src/lib/trace-datasets/sampling/budgeted-proxy';
import { incrementalSample, incrementalSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-incremental';
import { informationFeaturesSteps, informationSample, informationSampleSteps } from '../src/lib/trace-datasets/sampling/answer-information';
import { informationSearchSample, informationSearchSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-information';
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

test('incremental crossing preserves every original result and diagnostic across ties, random pools and long inputs',()=>{
  const base=fixture().rows[0];
  for(let seed=1;seed<=24;seed++){
    let x=seed;const next=()=>{x=(x*1664525+1013904223)>>>0;return x;};
    const rows=Array.from({length:20},(_,i)=>{const terms=[...new Set(Array.from({length:seed===24?1100:3+next()%12},(_,j)=>`t${seed===24?j+i:next()%35}`))];return {...base,key:`k${i}`,inputKey:`q${i}`,lexical:{terms,tokenCount:terms.length+next()%5},paths:[{key:`p${i}`,cells:['required'],knownDimensions:1}]};});
    const initial=rows.slice(0,5).map(r=>({key:r.key,path:r.paths[0],reason:'initial'})),features=drain(directAnswerFeaturesSteps(rows,new Map(rows.map(r=>[r.key,'answer']))));
    const settings={seed,tokenBudget:actual(rows,initial).tokens,distributionEnabled:true};
    assert.deepEqual(drain(incrementalCrossingSteps(rows,initial,features,settings)),drain(prunedCrossingSteps(rows,initial,features,settings)));
  }
});

test('incremental full pipeline exactly replays v6.19 including every diagnostic and fallback', () => {
  const { rows, answers } = fixture();
  for (const k of [1,12,40,500]) for (const budgetRatio of [1,1.1,1.2]) {
    const old = proxySample(rows,answers,k,undefined,{budgetRatio}), next = incrementalSample(rows,answers,k,undefined,{budgetRatio});
    assert.deepEqual({...next,optimization:{...next.optimization,requestedPolicy:old.optimization.requestedPolicy,effectivePolicy:old.optimization.effectivePolicy}},old);
    assert.deepEqual(incrementalSample([...rows].reverse(),answers,k,undefined,{budgetRatio}),next);
  }
});

test('information score has analytic saturation and trigram repetition penalties with duplicate invariance', () => {
  const base = fixture().rows[0];
  const answers = new Map([['a','one two three'],['b','one two three one two three'],['copy','one two three'],['short','one two'],['empty','...']]);
  const rows = [...answers.keys()].map(key=>({...base,key,inputKey:'one-input'}));
  const pair = drain(pairedAnswerFeaturesSteps(rows,answers));
  for(const key of answers.keys())pair.high.scores.set(key,.4);
  const result = drain(informationFeaturesSteps(pair.high,pair.records));
  assert.equal(result.scores.get('a'),.75*.4+.25*3/35);
  assert.equal(result.scores.get('b'),.75*.4+.25*(3/35)*(3/4));
  assert.equal(result.scores.get('short'),.75*.4+.25*2/34);
  assert.equal(result.scores.get('empty'),.75*.4);
  assert.equal(result.scores.get('copy'),result.scores.get('a'));
  assert.equal(result.groupScores.get('one-input'),[...answers.keys()].filter(k=>k!=='copy').reduce((n,k)=>n+result.scores.get(k)!,0)/4);
});

test('information features preserve Unicode token boundaries and do not mutate shared features', () => {
  const base=fixture().rows[0], text='你好 café 你好 café', rows=[{...base,key:'unicode',inputKey:'unicode'}], answers=new Map([['unicode',text]]);
  const pair=drain(pairedAnswerFeaturesSteps(rows,answers)), grounded=drain(groundedFeaturesSteps(pair.high,pair.records));
  const before=structuredClone(pair), first=drain(informationFeaturesSteps(grounded,pair.records));
  assert.deepEqual(pair,before);assert.deepEqual(first,drain(informationFeaturesSteps(grounded,pair.records)));
  const terms=lexicalFeatures(text);assert.equal(terms.terms.length,3);assert.equal(terms.tokenCount,6);
  assert.equal(first.scores.get('unicode'),.75*grounded.scores.get('unicode')!+.25*(3/35)*(3/4));
});

test('information answers and exchanges protect coverage, input counts, budget, tasks and real paths', () => {
  const {rows,answers}=fixture(), input=(key:string)=>rows.find(r=>r.key===key)!.inputKey;
  for(const k of [1,12,40,500])for(const budgetRatio of [1,1.1,1.2]){
    const a=incrementalSample(rows,answers,k,undefined,{budgetRatio}),b=informationSample(rows,answers,k,undefined,{budgetRatio}),c=informationSearchSample(rows,answers,k,undefined,{budgetRatio});
    assert.deepEqual(b.selected.map(s=>input(s.key)),a.selected.map(s=>input(s.key)));assert.deepEqual(actual(rows,b.selected),actual(rows,a.selected));
    assert.equal(c.selected.length,b.selected.length);assert.equal(new Set(c.selected.map(s=>s.key)).size,c.selected.length);assert.equal(new Set(c.selected.map(s=>input(s.key))).size,new Set(b.selected.map(s=>input(s.key))).size);
    assert.deepEqual(actual(rows,c.selected),{vocabulary:c.optimization.vocabulary,tokens:c.optimization.tokens});
    if(b.optimization.feasible){assert.ok(c.optimization.vocabulary>=b.optimization.vocabulary);assert.ok(c.optimization.tokens<=c.optimization.tokenBudget);assert.ok(c.optimization.lengthTV<=c.optimization.lengthLimit+1e-9);assert.ok(c.optimization.taskTV<=c.optimization.taskLimit+1e-9);assert.ok(c.informationSearch.finalScore!>=c.informationSearch.initialScore!-1e-12);}
    const cells=new Set(c.selected.flatMap(s=>s.path.cells));for(const cell of b.selected.flatMap(s=>s.path.cells))assert.ok(cells.has(cell));
    for(const s of c.selected)assert.ok(rows.find(r=>r.key===s.key)!.paths.some(p=>p.key===s.path.key));
    assert.deepEqual(c,informationSearchSample([...rows].reverse(),answers,k,undefined,{budgetRatio}));
  }
});

test('information candidates retain cancellation, fallback and production default without input mutation', () => {
  const {rows,answers}=fixture(), snapshot=structuredClone(rows);
  for(const stepsFn of [incrementalSampleSteps,informationSampleSteps,informationSearchSampleSteps]){const steps=stepsFn(rows,answers,12);assert.equal(steps.next().done,false);steps.return(undefined as never);}
  assert.deepEqual(rows,snapshot);assert.equal(POLICY.version,'trace-coverage-v4');
  assert.throws(()=>informationSearchSample(rows,answers,0),/INVALID_CONFIG/);
  assert.throws(()=>informationSearchSample(rows,answers,12,undefined,{budgetRatio:1.5}),/INVALID_CONFIG/);
  const base=rows[0], impossible=Array.from({length:31},(_,i)=>({...base,key:`impossible${i}`,inputKey:`impossible${i}`,task:i?'unknown':'rare-task',lexical:{terms:[`term${i}`],tokenCount:i?1:10000},paths:[{key:`path${i}`,cells:[],knownDimensions:0}]}));
  const texts=new Map(impossible.map(r=>[r.key,'reference answer'])), original=proxySample(impossible,texts,2);
  assert.equal(original.optimization.feasible,false);
  for(const sampler of [incrementalSample,informationSample,informationSearchSample]){
    const result=sampler(impossible,texts,2);assert.equal(result.optimization.feasible,false);assert.equal(result.optimization.effectivePolicy,'trace-coverage-v4');assert.deepEqual(result.selected,original.selected);
  }
});
