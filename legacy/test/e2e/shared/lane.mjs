import {loadExecutionConfig} from './config.mjs';
import path from 'node:path';
export function laneConfig(lane,stateRoot,config=loadExecutionConfig({profile:lane})){
 if(!['pr','daily'].includes(lane))throw Error('Unknown test lane');
 if(!stateRoot||!path.isAbsolute(stateRoot)||path.resolve(stateRoot)==='/')throw Error('An isolated absolute state directory is required');
 const home=path.join(path.resolve(stateRoot),lane);
 return {lane,username:config.account.username,home,appHome:path.join(home,'app')};
}
export function newTraceRows(rows,previous){const old=new Set(previous);return rows.filter(row=>!old.has(row.taskId));}
import fs from 'node:fs';
export function acquireLane(lane,runId){
 if(!/^[a-z0-9-]+$/.test(runId))throw Error('Invalid run ID');
 fs.mkdirSync(lane.home,{recursive:true,mode:0o700});
 const marker=path.join(lane.home,'.e2e-lane');
 if(!fs.existsSync(marker)&&fs.existsSync(lane.appHome)&&fs.readdirSync(lane.appHome).length)throw Error('Refusing to reuse an unmarked application directory');
 if(fs.existsSync(marker)&&fs.readFileSync(marker,'utf8').trim()!==lane.username)throw Error('Configured account differs from existing lane; explicit migration required');
 const lock=path.join(lane.home,'run.lock');const fd=fs.openSync(lock,'wx',0o600);fs.writeSync(fd,JSON.stringify({pid:process.pid,runId}));fs.closeSync(fd);
 let released=false;const release=()=>{if(!released){released=true;fs.unlinkSync(lock);}};
 try{
  fs.writeFileSync(marker,lane.username,{mode:0o600});
  const backup=path.join(lane.home,'backups',runId);
  if(fs.existsSync(lane.appHome))fs.cpSync(lane.appHome,backup,{recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false});
  fs.mkdirSync(lane.appHome,{recursive:true,mode:0o700});return {backup,release};
 }catch(error){release();throw error;}
}
