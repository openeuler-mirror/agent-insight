import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
export function boundedUtEnv(root,env,timeoutMs=300000,cpus,{project,metricsFile}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100)throw Error('Invalid UT file timeout');
 if(cpus!==undefined&&(!Number.isFinite(cpus)||cpus<=0))throw Error('Invalid UT file concurrency');
 if(metricsFile){
  if(!path.isAbsolute(project||'')||!path.isAbsolute(metricsFile)||!path.relative(path.join(root,'private'),metricsFile)||path.relative(path.join(root,'private'),metricsFile).startsWith('..'))throw Error('Invalid private UT metrics path');
  fs.mkdirSync(path.dirname(metricsFile),{recursive:true,mode:0o700});fs.writeFileSync(metricsFile,'',{mode:0o600});fs.chmodSync(metricsFile,0o600);
 }
 const bin=path.join(root,'ut-bin');fs.mkdirSync(bin,{recursive:true,mode:0o700});
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 const guard=path.join(bin,'file-deadline.mjs');
 const profile=metricsFile?`import {appendFileSync,realpathSync} from 'node:fs';import path from 'node:path';\nlet file='';try{file=path.relative(${JSON.stringify(fs.realpathSync(project))},realpathSync(process.argv[1]||process.cwd())).split(path.sep).join('/');}catch{}\nif(process.env.NODE_TEST_CONTEXT==='child-v8'&&file.startsWith('test/')&&!file.split('/').includes('..')&&file.endsWith('.test.ts')){const start=performance.now(),cpu=process.cpuUsage();const record=value=>{try{appendFileSync(${JSON.stringify(metricsFile)},JSON.stringify({pid:process.pid,file,...value})+'\\n',{mode:0o600});}catch{}};record({event:'start'});process.once('exit',code=>{const usage=process.cpuUsage(cpu);record({event:'exit',durationMs:performance.now()-start,cpuMs:(usage.user+usage.system)/1000,maxRssBytes:process.resourceUsage().maxRSS*1024,exitCode:code});});}\n`:'';
 fs.writeFileSync(guard,`import {writeSync} from 'node:fs';\n${profile}\nif(process.env.NODE_TEST_CONTEXT==='child-v8'){setTimeout(()=>{writeSync(2,'E2E_UT_FILE_TIMEOUT '+JSON.stringify({file:process.argv[1],timeoutMs:${timeoutMs},checkpoint:process.env.E2E_UT_CHECKPOINT||null})+' test file timeout\\n');process.exit(124);},${timeoutMs}).unref();}\n`,{mode:0o600});
 const concurrency=cpus===undefined?'':`--test-concurrency=${Math.max(1,Math.floor(cpus))} `;
 fs.writeFileSync(path.join(bin,'node'),`#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--test" ]; then exec ${quote(process.execPath)} ${concurrency}--import ${quote(pathToFileURL(guard).href)} --test-timeout=${timeoutMs+1000} "$@"; fi\ndone\nexec ${quote(process.execPath)} "$@"\n`,{mode:0o700});
 return {...env,PATH:bin+path.delimiter+env.PATH};
}

export function readUtFileMetrics(file){
 const started=new Map(),completed=new Map();let invalidRecords=0,active=0,maxActiveFiles=0;
 for(const line of (fs.existsSync(file)?fs.readFileSync(file,'utf8'):'').split('\n')){
  if(!line)continue;
  try{
   const row=JSON.parse(line);
   if(!Number.isSafeInteger(row.pid)||row.pid<1||typeof row.file!=='string'||!row.file.startsWith('test/')||row.file.includes('\\')||row.file.split('/').includes('..')||/[\x00-\x1f\x7f]/.test(row.file)||!row.file.endsWith('.test.ts')){invalidRecords++;continue;}
   const key=row.pid+':'+row.file;
   if(row.event==='start'&&!started.has(key)){started.set(key,row.file);maxActiveFiles=Math.max(maxActiveFiles,++active);}
   else if(row.event==='exit'&&started.has(key)&&!completed.has(key)&&['durationMs','cpuMs','maxRssBytes'].every(k=>Number.isFinite(row[k])&&row[k]>=0)&&Number.isInteger(row.exitCode)){completed.set(key,{file:row.file,durationMs:row.durationMs,cpuMs:row.cpuMs,maxRssBytes:row.maxRssBytes,exitCode:row.exitCode});active--;}
   else invalidRecords++;
  }catch{invalidRecords++;}
 }
 const files=[...completed.values()].sort((a,b)=>b.durationMs-a.durationMs||a.file.localeCompare(b.file));
 return {available:started.size>0,startedFiles:started.size,completedFiles:completed.size,uniqueFiles:new Set(started.values()).size,incompleteFiles:started.size-completed.size,failedFiles:files.filter(row=>row.exitCode!==0).length,maxActiveFiles,invalidRecords,files};
}
