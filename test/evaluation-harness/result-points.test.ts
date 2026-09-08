import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildCheckPoints} from '../../src/lib/evaluation-harness/result-points';
import type {Check} from '../../src/lib/evaluation-harness/domain';
test('rule points keep turn evidence, recommendations and unknown scores separate',()=>{
 const checks:Check[]=[{turn:2,name:'工具参数',verdict:'fail',reason:'approve_loan',blocking:true},{turn:1,name:'路由',verdict:'unknown',reason:'未采集',blocking:true},{turn:0,name:'语义',verdict:'unknown',reason:'关键失败跳过',blocking:false,skipped:true}];
 const points=buildCheckPoints(checks,[{input:'first',output:'ask'},{input:'risk high',output:'approved',tools:[{name:'approve_loan',arguments:{amount:80000}}]}]);
 assert.equal(points[0].score,0);assert.match(points[0].evidence.md,/80000/);assert.match(points[0].suggestion,/参数/);assert.deepEqual(points[0].anchors,['turn-2']);
 assert.equal(points[1].score,undefined);assert.match(points[1].label,/未评完整/);assert.equal(points[2].score,undefined);assert.match(points[2].label,/已跳过/);
});
