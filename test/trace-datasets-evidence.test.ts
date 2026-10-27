import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,lexicalFeatures,signature,LEGACY_POLICY,sample,type Candidate,type Selection} from '../src/lib/trace-datasets/sampling';
import {pairedAnswerFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-memo-paired';
import {groundedFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-sparse-grounded';
import {phraseFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-phrase';
import {proxyImproveSteps} from '../src/lib/trace-datasets/sampling/budgeted-proxy';
import {supportedImproveSteps} from '../src/lib/trace-datasets/sampling/budgeted-supported-proxy';
import {evidenceSample,supportedReplaceSteps,EVIDENCE_POLICIES as policies} from '../src/lib/trace-datasets/sampling/budgeted-evidence';
import { PRODUCTION_POLICY, productionSampleSteps } from '../src/lib/trace-datasets/sampling/production';
import {pairedAnswerFeaturesSteps as originalPaired} from '../src/lib/trace-datasets/sampling/answer-paired';
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

test('production evidence preserves feasible constraints, real paths, counts and deterministic ordering', () => {
  const { rows, answers } = fixture(), before = structuredClone(rows);
  const byKey = new Map(rows.map(row => [row.key, row]));
  for (const k of [1, 12, 40, 500]) for (const budgetRatio of [1, 1.1, 1.2]) {
    const result = evidenceSample(rows, answers, k, policies.V635, { budgetRatio });
    assert.equal(result.selected.length, Math.min(k, rows.length));
    assert.equal(new Set(result.selected.map(s => s.key)).size, result.selected.length);
    assert.deepEqual(actual(rows, result.selected), { vocabulary: result.optimization.vocabulary, tokens: result.optimization.tokens });
    for (const selected of result.selected) assert.ok(byKey.get(selected.key)!.paths.some(p => p.key === selected.path.key));
    if (result.optimization.feasible) {
      assert.ok(result.optimization.tokens <= result.optimization.tokenBudget);
      assert.ok(result.optimization.lengthTV <= result.optimization.lengthLimit + 1e-9);
      assert.ok(result.optimization.taskTV <= result.optimization.taskLimit + 1e-9);
    }
    assert.deepEqual(evidenceSample([...rows].reverse(), answers, k, policies.V635, { budgetRatio }), result);
  }
  assert.deepEqual(rows, before);
});

test('production evidence retains cancellation, invalid input rejection and infeasible v4 fallback', () => {
  const { rows, answers } = fixture(), before = structuredClone(rows);
  const steps = productionSampleSteps(rows, answers, 12);
  assert.equal(steps.next().done, false);
  steps.return(undefined as never);
  assert.deepEqual(rows, before);
  assert.throws(() => evidenceSample(rows, answers, 0, policies.V635), /INVALID_CONFIG/);
  assert.throws(() => evidenceSample(rows, answers, 12, { ...policies.V635, version: 'bad' }), /INVALID_CONFIG/);
  const bad = Array.from({ length: 31 }, (_, i) => ({ ...rows[0], key: `i${i}`, inputKey: `i${i}`, task: i ? 'unknown' : 'rare-task', lexical: { terms: [`t${i}`], tokenCount: i ? 1 : 10000 }, paths: [{ key: `p${i}`, cells: [], knownDimensions: 0 }] }));
  const texts = new Map(bad.map(row => [row.key, 'reference answer']));
  const result = evidenceSample(bad, texts, 2, policies.V635);
  assert.deepEqual(drain(productionSampleSteps(bad, texts, 2)), result);
  assert.equal(result.optimization.feasible, false);
  assert.equal(result.optimization.effectivePolicy, LEGACY_POLICY.version);
  assert.deepEqual(result.selected, sample(bad, 2, { ...LEGACY_POLICY, seed: PRODUCTION_POLICY.seed, rho: PRODUCTION_POLICY.rho }).selected);
});
