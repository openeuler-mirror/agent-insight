import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Queue {
  constructor(file) {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);fs.chmodSync(file,0o600);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, repository TEXT NOT NULL, pr INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, result TEXT);");
  }
  enqueue(job) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing=this.get(job.id);
      if(existing){this.db.exec('COMMIT');return {created:false,job:existing};}
      this.db.prepare("UPDATE jobs SET state='SUPERSEDED' WHERE repository=? AND pr=? AND state IN ('QUEUED','RUNNING')").run(job.repository,job.pr);
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?, 'QUEUED', ?,NULL)").run(job.id,job.repository,job.pr,JSON.stringify(job),Date.now());
      this.db.exec('COMMIT');return {created:true,job:this.get(job.id)};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  decode(row){return row?{...JSON.parse(row.payload),state:row.state,result:row.result?JSON.parse(row.result):null}:null;}
  get(id){return this.decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));}
  list(){return this.db.prepare('SELECT * FROM jobs ORDER BY created,id').all().map(row=>this.decode(row));}
  claim(){
    this.db.exec('BEGIN IMMEDIATE');
    try{const row=this.db.prepare("SELECT * FROM jobs WHERE state='QUEUED' ORDER BY created,id LIMIT 1").get();
      if(row)this.db.prepare("UPDATE jobs SET state='RUNNING' WHERE id=?").run(row.id);
      this.db.exec('COMMIT');return row?this.get(row.id):null;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  finish(id,state,result){
    if(!['COMPLETED','BLOCKED','ERROR','INTERRUPTED','SUPERSEDED'].includes(state))throw Error('Invalid terminal state');
    return this.db.prepare("UPDATE jobs SET state=?,result=? WHERE id=? AND state='RUNNING'").run(state,JSON.stringify(result),id).changes===1;
  }
  recover(){this.db.exec("UPDATE jobs SET state='INTERRUPTED' WHERE state='RUNNING'");}
  close(){this.db.close();}
}
