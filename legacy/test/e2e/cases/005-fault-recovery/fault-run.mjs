import assert from 'node:assert/strict';
export function currentFaultRun(db,{experimentId,user,clientId}){
 const experiment=db.prepare('SELECT user FROM Experiment WHERE id=?').get(experimentId);
 assert.equal(experiment?.user,user,'FI experiment belongs to another account');
 const cases=db.prepare('SELECT fiRunId FROM ExperimentCase WHERE experimentId=?').all(experimentId);
 assert.ok(cases.length<=1,'Unexpected extra fault case in current experiment');
 if(!cases[0]?.fiRunId)return;
 const rows=db.prepare('SELECT * FROM FaultInjectionRun WHERE runId=? OR id=?').all(cases[0].fiRunId,cases[0].fiRunId);
 assert.ok(rows.length<=1,'Ambiguous FI run binding');
 if(!rows.length)return;
 assert.equal(rows[0].user,user,'FI run belongs to another account');
 if(rows[0].workerId||rows[0].status!=='queued')assert.equal(rows[0].workerId,clientId,'FI run belongs to another client');
 return rows[0];
}
