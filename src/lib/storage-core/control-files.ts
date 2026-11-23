import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {getAgentInsightDataDir,getSkillVersionStorageDir,resolveRuntimeAssetPath} from '@/lib/env';
import {requireCoreControlContext} from './control-context';
export interface ControlFile {path:string;content:string;mode:number}
const fail=(message:string)=>Object.assign(new Error(message),{status:400});
function relative(value:string){if(!value||value.length>2048||value.includes('\\')||value.startsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..')||/[\u0000-\u001f]/.test(value))throw fail('Invalid Skill file path');return value;}
function safeRoot(root:string){let cursor=path.parse(root).root;for(const part of path.resolve(root).slice(cursor.length).split(path.sep)){cursor=path.join(cursor,part);if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw fail('Skill file symlinks are unsupported');}}
export function captureControlSkillFiles(row:Record<string,any>):ControlFile[]{
 let list:unknown;try{list=JSON.parse(row.files||'[]');}catch{throw fail('Invalid Skill file list');}
 const files:ControlFile[]=[];const names=Array.isArray(list)?list:typeof list==='object'&&list?Object.keys(list):[];
 const expected=path.resolve(getSkillVersionStorageDir(row.skillId,row.version));const cache=path.resolve(getAgentInsightDataDir(),'storage','core-control-files');const root=path.resolve(row.assetPath?resolveRuntimeAssetPath(row.assetPath):expected);
 if(root!==expected&&!root.startsWith(cache+path.sep))throw fail('Skill file source must be its version storage directory');safeRoot(root);let bytes=0;
 for(const name of names){if(typeof name!=='string')throw fail('Invalid Skill file list');const rel=relative(name);let buffer:Buffer,mode=0o600;
  if(!Array.isArray(list)&&typeof (list as any)[name]==='string')buffer=Buffer.from((list as any)[name]);
  else if(name.toUpperCase()==='SKILL.MD')buffer=Buffer.from(row.content||'');
  else {const file=path.join(root,rel);safeRoot(file);if(!fs.existsSync(file))throw fail('Skill file is missing: '+rel);const info=fs.lstatSync(file);if(!info.isFile()||info.size>128*1024*1024)throw fail('Invalid Skill file');buffer=fs.readFileSync(file);mode=info.mode&0o777;}
  bytes+=buffer.length;if(bytes>128*1024*1024||files.length>=10000)throw fail('Skill file package exceeds budget');files.push({path:rel,content:buffer.toString('base64'),mode});
 }
 return files;
}
export function materializeControlSkillFiles(row:Record<string,any>,files:ControlFile[]):string{
 const context=requireCoreControlContext(),scope=createHash('sha256').update([context.origin,context.actor.workspace,context.actor.principal].join('\0')).digest('hex');
 const digest=createHash('sha256').update(JSON.stringify(files)).digest('hex');const folder=path.join(getAgentInsightDataDir(),'storage','core-control-files',scope,createHash('sha256').update(String(row.skillId)).digest('hex'),'v'+row.version,digest);safeRoot(folder);
 fs.mkdirSync(folder,{recursive:true,mode:0o700});
 for(const file of files){const target=path.join(folder,relative(file.path));safeRoot(target);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});const buffer=Buffer.from(file.content,'base64');
  if(fs.existsSync(target)){if(!fs.lstatSync(target).isFile()||!fs.readFileSync(target).equals(buffer))throw fail('Materialized Skill file differs');continue;}
  const temporary=target+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,buffer,{flag:'wx',mode:file.mode&0o777});fs.renameSync(temporary,target);
 }
 (context.skillDirectories??=new Map()).set(row.skillId+'\0'+row.version,folder);return folder;
}
export function materializedControlSkillDirectory(skillId:string,version:number):string{const value=requireCoreControlContext().skillDirectories?.get(skillId+'\0'+version);if(!value)throw Object.assign(new Error('Authorized Skill files must be loaded before resolving a local directory'),{status:503});return value;}
