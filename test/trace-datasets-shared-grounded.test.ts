/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, lexicalFeatures, signature, POLICY, type Candidate, type Selection } from '../src/lib/trace-datasets/sampling';
import { pairedAnswerFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-paired';
import { sharedSample, sharedSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-shared';
import { groundedFeaturesSteps, groundedSample, groundedSampleSteps } from '../src/lib/trace-datasets/sampling/answer-grounded';
import { proxyImproveSteps, proxySample, proxySampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-proxy';
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

test('grounded proxy weights input-group frequency once and measures only lexical recall',()=>{
  const base=fixture().rows[0];
  const rows=['a','b','copy','x'].map(key=>({...base,key,inputKey:key==='x'?'other':'q',lexical:lexicalFeatures(key==='x'?'common':'common rare')}));
  const answers=new Map([['a','common'],['b','common rare'],['copy','common rare'],['x','common']]);
  const pair=drain(pairedAnswerFeaturesSteps(rows,answers));for(const key of ['a','b','copy'])pair.high.scores.set(key,.5);
  const f=drain(groundedFeaturesSteps(pair.high,pair.records));
  assert.equal(f.scores.get('a'),.75*.5+.25/(2+Math.log(3/2)));assert.equal(f.scores.get('b'),.75*.5+.25);assert.equal(f.scores.get('copy'),f.scores.get('b'));
});

test('proxy exchanges choose real compatible paths and improve score without spending coverage or budget floors',()=>{
  const base=fixture().rows[0];
  const rows=[['a','a',['one','two'],'left'],['b','b',['three','four'],'right'],['c-bad','c',['one','two','extra'],'wrong'],['c-good','c',['one','two','extra'],'left'],['d','d',['three','four'],'right']].map(([key,inputKey,terms,cell])=>({...base,key:key as string,inputKey:inputKey as string,lexical:{terms:terms as string[],tokenCount:4},paths:[{key:`${key}-path`,cells:[cell as string],knownDimensions:1}]}));
  const features=drain(pairedAnswerFeaturesSteps(rows,new Map(rows.map(r=>[r.key,'answer'])))).recall;for(const [key,score] of [['a',.1],['b',.1],['c-bad',1],['c-good',.9],['d',.8]] as const)features.scores.set(key,score);
  const initial=rows.slice(0,2).map(r=>({key:r.key,path:r.paths[0],reason:'initial'}));
  const result=drain(proxyImproveSteps(rows,initial,features,{tokenBudget:8,distributionEnabled:true}));
  assert.deepEqual(new Set(result.selected.map(s=>s.key)),new Set(['c-good','d']));assert.equal(result.vocabulary,5);assert.equal(result.tokens,8);assert.ok(result.proxy.finalScore>result.proxy.initialScore);assert.deepEqual(actual(rows,result.selected),{vocabulary:result.vocabulary,tokens:result.tokens});
  assert.throws(()=>drain(proxyImproveSteps(rows,initial,features,{tokenBudget:7,distributionEnabled:true})),/INFEASIBLE_START/);
});

test('grounded answers preserve inputs and proxy search preserves all constraints across mixed variants',()=>{
  const {rows,answers}=fixture(),input=(key:string)=>rows.find(r=>r.key===key)!.inputKey;
  for(const k of [1,12,40,500])for(const budgetRatio of [1,1.1,1.2]){
    const a=sharedSample(rows,answers,k,undefined,{budgetRatio}),b=groundedSample(rows,answers,k,undefined,{budgetRatio}),c=proxySample(rows,answers,k,undefined,{budgetRatio});
    assert.deepEqual(b.selected.map(s=>input(s.key)),a.selected.map(s=>input(s.key)));assert.deepEqual(actual(rows,b.selected),actual(rows,a.selected));
    assert.equal(c.selected.length,b.selected.length);assert.equal(new Set(c.selected.map(s=>s.key)).size,c.selected.length);assert.equal(new Set(c.selected.map(s=>input(s.key))).size,new Set(b.selected.map(s=>input(s.key))).size);
    assert.deepEqual(actual(rows,c.selected),{vocabulary:c.optimization.vocabulary,tokens:c.optimization.tokens});
    if(b.optimization.feasible){assert.ok(c.optimization.vocabulary>=b.optimization.vocabulary);assert.ok(c.optimization.tokens<=c.optimization.tokenBudget);assert.ok(c.optimization.lengthTV<=c.optimization.lengthLimit+1e-9);assert.ok(c.optimization.taskTV<=c.optimization.taskLimit+1e-9);assert.ok(c.proxy.finalScore!>=c.proxy.initialScore!-1e-12);}
    const cells=new Set(c.selected.flatMap(s=>s.path.cells));for(const cell of b.selected.flatMap(s=>s.path.cells))assert.ok(cells.has(cell));
    assert.deepEqual(c,proxySample([...rows].reverse(),answers,k,undefined,{budgetRatio}));
  }
});

test('shared and proxy candidates remain cancellable without mutation or default changes',()=>{
  const {rows,answers}=fixture(),snapshot=structuredClone(rows);
  for(const sampleSteps of [sharedSampleSteps,groundedSampleSteps,proxySampleSteps]){const steps=sampleSteps(rows,answers,12);assert.equal(steps.next().done,false);steps.return(undefined as never);}
  assert.deepEqual(rows,snapshot);assert.equal(POLICY.version,'trace-coverage-v4');
  assert.throws(()=>proxySample(rows,answers,0),/INVALID_CONFIG/);
});
