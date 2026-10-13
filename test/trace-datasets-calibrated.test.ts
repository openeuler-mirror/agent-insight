import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,lexicalFeatures,signature,POLICY,type Candidate,type Selection} from '../src/lib/trace-datasets/sampling';
import {pairedAnswerFeaturesSteps as originalPaired} from '../src/lib/trace-datasets/sampling/answer-paired';
import {pairedAnswerFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-sparse-paired';
import {groundedFeaturesSteps as originalGrounded} from '../src/lib/trace-datasets/sampling/answer-grounded';
import {groundedFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-sparse-grounded';
import {proxySample} from '../src/lib/trace-datasets/sampling/budgeted-proxy';
import {calibratedFeaturesSteps,representativeFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-calibrated';
import {calibratedSample,calibratedSampleSteps,CALIBRATED_POLICIES as policies} from '../src/lib/trace-datasets/sampling/budgeted-calibrated';
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

test('sparse paired and grounded features exactly match originals including summation order, singletons and Unicode',()=>{
  const {rows,answers}=fixture();const old=drain(originalPaired(rows,answers)),next=drain(pairedAnswerFeaturesSteps(rows,answers));assert.deepEqual(next,old);
  assert.deepEqual(drain(groundedFeaturesSteps(next.high,next.records)),drain(originalGrounded(old.high,old.records)));
  for(let seed=1;seed<=20;seed++){
    const input='你好 café '+Array.from({length:1100},(_,j)=>`term${j}`).join(' '),row={...rows[0],key:'a',inputKey:'q',lexical:lexicalFeatures(input)},texts=new Map([['a',`term${seed} term${seed+100} term${seed+300} 你好`]]);
    const paired=drain(pairedAnswerFeaturesSteps([row],texts));assert.deepEqual(drain(groundedFeaturesSteps(paired.high,paired.records)),drain(originalGrounded(paired.high,paired.records)));
  }
});
test('v626 fully replays v619 across budgets, output counts, ordering and diagnostics',()=>{
  const {rows,answers}=fixture();for(const k of [1,12,40,500])for(const budgetRatio of [1,1.1,1.2]){
    const old=proxySample(rows,answers,k,undefined,{budgetRatio}),next=calibratedSample(rows,answers,k,policies.V626,{budgetRatio});
    assert.deepEqual({...next,optimization:{...next.optimization,requestedPolicy:old.optimization.requestedPolicy,effectivePolicy:old.optimization.effectivePolicy}},old);
  }
});
test('discounted consensus uses quarter weight for copied terms and deduplicates supporting answers',()=>{
  const base=fixture().rows[0],rows=['a','b','copy'].map(key=>({...base,key,inputKey:'q',lexical:lexicalFeatures('alpha')})),answers=new Map([['a','alpha beta'],['b','alpha gamma'],['copy','alpha beta']]);
  const p=drain(pairedAnswerFeaturesSteps(rows,answers)),g=drain(groundedFeaturesSteps(p.high,p.records));const before=structuredClone(p);
  const f=drain(calibratedFeaturesSteps('discount',g,p.high,p.records));assert.ok(Math.abs(f.scores.get('a')!-.4)<1e-14);assert.equal(f.scores.get('a'),f.scores.get('copy'));assert.equal(f.comparisons,2);assert.deepEqual(p,before);
});
test('length calibration uses the median of distinct answers, not their duplicate count',()=>{
  const base=fixture().rows[0],answers=new Map([['a','one two'],['b','one two three four five six seven eight'],['copy','one two']]),rows=[...answers.keys()].map(key=>({...base,key,inputKey:'q'}));
  const p=drain(pairedAnswerFeaturesSteps(rows,answers));for(const key of answers.keys())p.high.scores.set(key,.4);
  const f=drain(calibratedFeaturesSteps('length',p.high,p.high,p.records));assert.equal(f.scores.get('a'),.9*.4+.1*.5);assert.equal(f.scores.get('b'),.9*.4+.1*(2/3));assert.equal(f.scores.get('copy'),f.scores.get('a'));
});
test('calibration preserves singleton evidence and handles empty lexical content',()=>{
  const base=fixture().rows[0],rows=[{...base,key:'a',inputKey:'q',lexical:lexicalFeatures('...')}],answers=new Map([['a','!!!']]),p=drain(pairedAnswerFeaturesSteps(rows,answers)),g=drain(groundedFeaturesSteps(p.high,p.records));
  for(const mode of ['discount','length'] as const)assert.deepEqual(drain(calibratedFeaturesSteps(mode,g,p.high,p.records)).scores,g.scores);
});
test('input representativeness uses distinct input document frequency and does not amplify answer variants',()=>{
  const base=fixture().rows[0],rows=[{...base,key:'a',inputKey:'q1',lexical:lexicalFeatures('common rare')},{...base,key:'copy',inputKey:'q1',lexical:lexicalFeatures('common rare')},{...base,key:'b',inputKey:'q2',lexical:lexicalFeatures('common')}],answers=new Map(rows.map(r=>[r.key,'same answer'])),p=drain(pairedAnswerFeaturesSteps(rows,answers));
  const f=drain(representativeFeaturesSteps(rows,p.high));assert.equal(f.scores.get('b'),.25);assert.ok(Math.abs(f.scores.get('a')!-.25*(1+Math.log(2)/Math.log(3))/2)<1e-14);assert.equal(f.scores.get('a'),f.scores.get('copy'));
});
test('all calibration branches preserve budgets, coverage floors, QA counts, task/path coverage and deterministic ordering',()=>{
  const {rows,answers}=fixture(),byKey=new Map(rows.map(r=>[r.key,r])),inputs=(s:Selection[])=>s.map(p=>byKey.get(p.key)!.inputKey),parents={V627:'V626',V628:'V627',V629:'V626',V630:'V629',V631:'V630'};
  for(const k of [1,12,40,500])for(const budgetRatio of [1,1.1,1.2]){
    const runs=new Map(Object.entries(policies).map(([v,p])=>[v,calibratedSample(rows,answers,k,p,{budgetRatio})]));
    for(const [v,parent] of Object.entries(parents)){
      const a=runs.get(parent)!,b=runs.get(v)!;assert.equal(a.selected.length,b.selected.length);assert.equal(new Set(b.selected.map(s=>s.key)).size,b.selected.length);
      assert.deepEqual(actual(rows,b.selected),{vocabulary:b.optimization.vocabulary,tokens:b.optimization.tokens});assert.equal(new Set(inputs(b.selected)).size,new Set(inputs(a.selected)).size);
      if(v==='V627'||v==='V629'){assert.deepEqual(inputs(b.selected),inputs(a.selected));assert.deepEqual(actual(rows,b.selected),actual(rows,a.selected));}
      if(a.optimization.feasible){assert.ok(b.optimization.vocabulary>=a.optimization.vocabulary);assert.ok(b.optimization.tokens<=b.optimization.tokenBudget);assert.ok(b.optimization.lengthTV<=b.optimization.lengthLimit+1e-9);assert.ok(b.optimization.taskTV<=b.optimization.taskLimit+1e-9);}
      const cells=new Set(b.selected.flatMap(s=>s.path.cells));for(const cell of a.selected.flatMap(s=>s.path.cells))assert.ok(cells.has(cell));for(const s of b.selected)assert.ok(byKey.get(s.key)!.paths.some(p=>p.key===s.path.key));
      assert.deepEqual(calibratedSample([...rows].reverse(),answers,k,policies[v],{budgetRatio}),b);
    }
  }
});
test('calibrated candidates retain cancellation, invalid config rejection, infeasible fallback and v4 default',()=>{
  const {rows,answers}=fixture(),before=structuredClone(rows);
  for(const p of Object.values(policies)){const g=calibratedSampleSteps(rows,answers,12,p);assert.equal(g.next().done,false);g.return(undefined as never);}
  assert.deepEqual(rows,before);assert.equal(POLICY.version,'trace-coverage-v4');assert.throws(()=>calibratedSample(rows,answers,0),/INVALID_CONFIG/);assert.throws(()=>calibratedSample(rows,answers,12,{...policies.V626,version:'bad'}),/INVALID_CONFIG/);
  const bad=Array.from({length:31},(_,i)=>({...rows[0],key:`i${i}`,inputKey:`i${i}`,task:i?'unknown':'rare-task',lexical:{terms:[`t${i}`],tokenCount:i?1:10000},paths:[{key:`p${i}`,cells:[],knownDimensions:0}]})),texts=new Map(bad.map(r=>[r.key,'reference answer'])),original=proxySample(bad,texts,2);
  assert.equal(original.optimization.feasible,false);for(const p of Object.values(policies)){const r=calibratedSample(bad,texts,2,p);assert.equal(r.optimization.effectivePolicy,'trace-coverage-v4');assert.deepEqual(r.selected,original.selected);}
});
