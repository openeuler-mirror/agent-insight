import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyCaseDrafts, updateCaseDraft, caseSummary} from '../../src/components/evaluation-harness/dataset-draft';
import type {EvalCase} from '../../src/lib/evaluation-harness/domain';
const a={id:'a',name:'A',turns:[{input:'first',expectedOutput:'middle'},{input:'second',expectedOutput:'final'}]} as EvalCase;
const b={...a,id:'b',name:'B'};
test('independent edits and deletions preserve the published snapshot and can be reverted separately',()=>{
 const base=[a,b];
 let draft=updateCaseDraft(base,{},'a',{...a,name:'Edited'});
 draft=updateCaseDraft(base,draft,'b',null);
 assert.deepEqual(applyCaseDrafts(base,draft).map(c=>c.name),['Edited']);
 draft=updateCaseDraft(base,draft,'a',a);
 assert.deepEqual(applyCaseDrafts(base,draft),[a]);
 draft=updateCaseDraft(base,draft,'b',b);
 assert.deepEqual(draft,{});
 assert.deepEqual(base,[a,b]);
});
test('summary takes first input and final expected output, without substituting an intermediate answer',()=>{
 assert.deepEqual(caseSummary(a),{input:'first',output:'final'});
 assert.equal(caseSummary({...a,turns:[...a.turns,{input:'end',expectedOutput:''}] as EvalCase['turns']}).output,'');
});
