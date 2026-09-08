import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVersionView } from '../../src/lib/evaluation-harness/versions';
const run = (id:string, version:number, date:string, score:number|null, condition='same', status='done', datasetVersion=1):any => ({ id, name:id, status, createdAt:date, summary:{score}, manifest:{target:{id:'a'+version,assetKey:'agent',name:'Agent',version},dataset:{id:'d'+datasetVersion,assetKey:'data',name:'Data',version:datasetVersion},comparisonHash:condition} });
test('default trend chooses a comparable cohort with multiple versions rather than newest replay',()=>{
 const view=buildVersionView([run('replay',2,'2026-09-07',100,'replay'),run('v2',2,'2026-09-06',100),run('v1',1,'2026-09-05',50)],'agent','data','agent');
 assert.equal(view.condition,'same'); assert.deepEqual(view.points.map(p=>p.summary.score),[50,100]); assert.equal(view.groups.length,2);
});
test('table retains every version pair and history while trend uses latest valid result per version',()=>{
 const view=buildVersionView([run('old',1,'2026-09-01',20),run('new',1,'2026-09-02',50),run('failed',1,'2026-09-03',null,'same','failed'),run('other',2,'2026-09-04',100,'same','done',3)],'agent','data','agent');
 assert.equal(view.groups.length,2);assert.equal(view.groups[0].runs.length,1);assert.equal(view.groups[1].runs[0].id,'failed');assert.ok(view.points.every(p=>p.status==='done'&&p.summary.score!==null));
});
test('axis switching fixes Agent and compares dataset versions; unrelated objects are excluded',()=>{
 const unrelated=run('unrelated',1,'2026-09-08',90);unrelated.manifest.target.assetKey='other';
 const view=buildVersionView([run('d1',2,'2026-09-01',50),run('d3',2,'2026-09-02',100,'same','done',3),unrelated],'agent','data','dataset');
 assert.equal(view.fixed,'2');assert.deepEqual(view.points.map(p=>p.manifest.dataset.version),[1,3]);assert.equal(view.runs.length,2);
});
test('no scored run yields no invented zero, and requested condition cannot mix incompatible scores',()=>{
 const empty=buildVersionView([run('pending',1,'2026-09-01',null,'same','running')],'agent','data','agent');assert.equal(empty.points.length,0);
 const split=buildVersionView([run('v1',1,'2026-09-01',50),run('v2',2,'2026-09-02',100,'different')],'agent','data','agent','1','different');assert.equal(split.points.length,1);assert.equal(split.points[0].id,'v2');
});
