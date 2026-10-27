import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,lexicalFeatures,signature,type Candidate} from '../src/lib/trace-datasets/sampling';
import {pairedAnswerFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-memo-paired';
import {groundedFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-sparse-grounded';
import {calibratedFeaturesSteps,representativeFeaturesSteps} from '../src/lib/trace-datasets/sampling/answer-calibrated';
import {pairedAnswerFeaturesSteps as originalPaired} from '../src/lib/trace-datasets/sampling/answer-paired';
import {groundedFeaturesSteps as originalGrounded} from '../src/lib/trace-datasets/sampling/answer-grounded';
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
test('production paired and grounded features exactly match shared implementations including summation order, singletons and Unicode',()=>{
  const {rows,answers}=fixture();const old=drain(originalPaired(rows,answers)),next=drain(pairedAnswerFeaturesSteps(rows,answers));assert.deepEqual(next,old);
  assert.deepEqual(drain(groundedFeaturesSteps(next.high,next.records)),drain(originalGrounded(old.high,old.records)));
  for(let seed=1;seed<=20;seed++){
    const input='你好 café '+Array.from({length:1100},(_,j)=>`term${j}`).join(' '),row={...rows[0],key:'a',inputKey:'q',lexical:lexicalFeatures(input)},texts=new Map([['a',`term${seed} term${seed+100} term${seed+300} 你好`]]);
    const paired=drain(pairedAnswerFeaturesSteps([row],texts));assert.deepEqual(drain(groundedFeaturesSteps(paired.high,paired.records)),drain(originalGrounded(paired.high,paired.records)));
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
