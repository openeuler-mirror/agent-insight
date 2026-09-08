import test from 'node:test';
import assert from 'node:assert/strict';
import {caseSelectionForVersion} from '../../src/lib/evaluation-harness/demo-selection';
test('regression always restores the saved subset even when its version equals the initial default',()=>{
 const dataset={id:'same',content:{cases:[{id:'one'},{id:'two'}]}};
 assert.deepEqual(caseSelectionForVersion(dataset,{datasetId:'same',caseIds:['two']}),['two']);
});
test('changing either cohort version replaces old IDs with cases from the selected version',()=>{
 const dataset={id:'new',content:{cases:[{id:'one'},{id:'added'}]}};
 assert.deepEqual(caseSelectionForVersion(dataset,{datasetId:'old',caseIds:['removed']}),['one','added']);
 assert.deepEqual(caseSelectionForVersion(dataset),['one','added']);
});
