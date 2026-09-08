import test from 'node:test';
import assert from 'node:assert/strict';
import {skillTriggerAccuracy} from '../../src/lib/evaluation-harness/rules';
test('Skill trigger metric distinguishes unwanted invocation from another route being incorrect and retains unknown evidence',()=>{
 const results:any=[{case:{turns:[{expectation:{expectedSkill:'loan'}},{expectation:{expectedSkill:'balance'}},{expectation:{expectedSkill:'loan'}},{expectation:{}}]},evidence:[{skill:'balance'},{skill:'other'},{},{}]}];
 assert.deepEqual(skillTriggerAccuracy(results,'loan'),{accuracy:50,total:4,pass:1,fail:1,unknown:2});
 assert.equal(skillTriggerAccuracy(results),null);
});
