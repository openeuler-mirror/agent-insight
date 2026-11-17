import test from 'node:test';import assert from 'node:assert/strict';
import {selectedCases,assertSelection} from './selection.mjs';
test('legacy core-five selects the four active cases; fault recovery remains excluded',()=>{
 assert.deepEqual(selectedCases('core-five'),['001','002','003','004']);
 assert.equal(selectedCases().length,5);assert.throws(()=>selectedCases('anything'),/profile/);
});
test('five-case validation rejects hidden 005 execution and incomplete selection even on failure',()=>{
 const report={selected:selectedCases('core-five'),scenarios:['001','002','003','004','005'].map(id=>({id,status:id==='005'?'NOT_RUN':'FAIL',stages:[]}))};
 assert.doesNotThrow(()=>assertSelection(report,'core-five'));
 assert.throws(()=>assertSelection({...report,selected:['001']},'core-five'),/selection/);
 assert.throws(()=>assertSelection({...report,scenarios:report.scenarios.map(s=>s.id==='005'?{...s,status:'PASS'}:s)},'core-five'),/excluded/);
 assert.throws(()=>assertSelection({...report,scenarios:report.scenarios.map(s=>s.id==='005'?{...s,stages:[{id:'injection',status:'FAIL'}]}:s)},'core-five'),/excluded/);
});
