import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const {currentFaultRun}=await import('./fault-run.mjs').catch(()=>({}));
test('FI selection follows this experiment case and ignores previous runs in a stable account',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE Experiment(id TEXT,user TEXT); CREATE TABLE ExperimentCase(experimentId TEXT,fiRunId TEXT); CREATE TABLE FaultInjectionRun(id TEXT,runId TEXT,user TEXT,workerId TEXT,status TEXT);
   INSERT INTO Experiment VALUES('old','pr'),('current','pr'),('daily','daily');
   INSERT INTO ExperimentCase VALUES('old','run-old'),('current',NULL),('daily','run-daily');
   INSERT INTO FaultInjectionRun VALUES('id-old','run-old','pr','old-client','failed'),('id-new','run-new','pr','new-client','completed'),('id-daily','run-daily','daily','daily-client','completed');`);
  const expected={experimentId:'current',user:'pr',clientId:'new-client'};
  assert.equal(typeof currentFaultRun,'function');
  assert.equal(currentFaultRun(db,expected),undefined);
  db.exec("UPDATE ExperimentCase SET fiRunId='run-new' WHERE experimentId='current'");
  assert.equal(currentFaultRun(db,expected).runId,'run-new');
  db.exec("UPDATE FaultInjectionRun SET workerId=NULL,status='queued' WHERE runId='run-new'");
  assert.equal(currentFaultRun(db,expected).status,'queued');
  db.exec("UPDATE FaultInjectionRun SET workerId='new-client',status='completed' WHERE runId='run-new'");
  db.exec("UPDATE ExperimentCase SET fiRunId='id-new' WHERE experimentId='current'");
  assert.equal(currentFaultRun(db,expected).runId,'run-new');
  assert.throws(()=>currentFaultRun(db,{...expected,clientId:'old-client'}));
  assert.throws(()=>currentFaultRun(db,{...expected,user:'daily'}));
  db.exec("UPDATE ExperimentCase SET fiRunId='run-daily' WHERE experimentId='current'");
  assert.throws(()=>currentFaultRun(db,expected));
  db.exec("INSERT INTO ExperimentCase VALUES('current','run-new')");
  assert.throws(()=>currentFaultRun(db,expected));
 }finally{db.close();}
});
