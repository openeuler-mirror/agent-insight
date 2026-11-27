import {loadExecutionConfig} from '../shared/config.mjs';
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
const quota=128*1024*1024;
export function collectState(root,lane,{maxBytes=quota}={}){
 if(!['pr','daily'].includes(lane))throw Error('Invalid lane');const files=[];let bytes=0;
 const base=path.join(root,lane,'app');if(!fs.existsSync(base))return {files};
 const walk=(dir,depth=0)=>{if(depth>20)throw Error('State depth quota exceeded');for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name),relative=path.relative(root,file);if(dir===base&&['client','logs','ras','fault-injection'].includes(entry.name)||entry.name==='__pycache__'||entry.name==='node_modules'&&relative.startsWith(lane+'/app/data/.opencode-runtime/'))continue;
  if(entry.isSymbolicLink())throw Error('State contains symbolic link');
  if(entry.isDirectory()){walk(file,depth+1);continue;}if(!entry.isFile())throw Error('State contains unsupported file');
  const size=fs.statSync(file).size;if(size>64*1024*1024||bytes+size>maxBytes||files.length>=20000)throw Error('State quota exceeded');const data=fs.readFileSync(file);bytes+=data.length;files.push({path:relative,data:data.toString('base64')});
 }};walk(base);return {files,bytes};
}
export function saveState(destination,state,lane){
 if(!['pr','daily'].includes(lane)||!Array.isArray(state.files)||state.files.length>20000)throw Error('Invalid exported state');fs.mkdirSync(destination,{recursive:true,mode:0o700});let bytes=0;
 for(const file of state.files){
  if(typeof file.path!=='string'||!file.path.startsWith(lane+'/app/')||file.path.length>1000||/[\\\x00-\x1f]/.test(file.path)||file.path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid state path');
  if(typeof file.data!=='string'||file.data.length>90*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))throw Error('Invalid state data');const data=Buffer.from(file.data,'base64');bytes+=data.length;if(bytes>quota)throw Error('State quota exceeded');
  const dest=path.join(destination,file.path);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,data,{flag:'wx',mode:0o600});
 }
 if(process.getuid?.()===0)for(const rel of ['',...fs.readdirSync(destination,{recursive:true})])fs.chownSync(path.join(destination,rel),1000,1000);
}
export function extractState(output){const line=output.split('\n').findLast(line=>line.startsWith('E2E_STATE_JSON:'));if(!line||line.length>180*1024*1024)throw Error('State export missing or too large');return JSON.parse(line.slice('E2E_STATE_JSON:'.length));}
export function verifyHistory(previous,next,lane,username=loadExecutionConfig({profile:lane}).account.username){
 assertStateAccount(previous,lane,username);assertStateAccount(next,lane,username);
 const file=root=>path.join(root,lane,'app/data/witty_insight.db');if(!fs.existsSync(file(previous)))return;
 const rows=root=>{const db=new DatabaseSync(file(root),{readOnly:true});try{
  const user=username;
  return [
   ...db.prepare('SELECT taskId,user,interactions FROM Session WHERE user=?').all(user).map(row=>({id:'session:'+row.taskId,value:row})),
   ...db.prepare('SELECT id,taskId,user,query,finalResult,agentName FROM Execution WHERE user=?').all(user).map(row=>({id:'execution:'+row.id,value:row})),
  ].map(row=>({id:row.id,hash:createHash('sha256').update(JSON.stringify(row.value)).digest('hex')}));
 }finally{db.close();}};
 const old=rows(previous),current=new Map(rows(next).map(row=>[row.id,row.hash]));for(const row of old)if(current.get(row.id)!==row.hash)throw Error('Historical Trace changed or disappeared; previous state retained');
}

export function assertStateAccount(root,lane,username){
 const marker=path.join(root,lane,'app','.e2e-account');if(fs.existsSync(marker)&&fs.readFileSync(marker,'utf8').trim()!==username)throw Error('Configured account differs from retained state; explicit migration required');
 const file=path.join(root,lane,'app/data/witty_insight.db');if(!fs.existsSync(file))return;
 const db=new DatabaseSync(file,{readOnly:true});try{for(const [table,column]of [['User','username'],['Execution','user'],['Session','user']]){
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
  if(db.prepare(`SELECT DISTINCT ${column} AS username FROM ${table} WHERE ${column} LIKE 'test%'`).all().some(row=>row.username!==username))throw Error('Configured account differs from retained state; explicit migration required');
 }}finally{db.close();}
}
