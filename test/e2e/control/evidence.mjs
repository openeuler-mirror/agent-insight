import fs from 'node:fs';
import path from 'node:path';

const maxTotalBytes=32*1024*1024;
const diagnosticJson=new Set(['fault-run.json','experiment.json','ras-evidence.json','ras-load-poll.json','ras-events-poll.json','fault-native-session.json','recovery-trace.json','baseline-trace.json','ingested-session.json','last-observed-session.json','diagnosis.json','verification.json','skills-verification.json','skill-reference-flow.json','baseline-experiment.json','candidate-experiment.json','optimization-session.json','candidate.json','dependency-audit.json']);
const allowed=name=>diagnosticJson.has(name)||/\.(png|zip|log)$/.test(name)||/^(report\.json|report\.html|summary\.md|coverage\.md)$/.test(name);
export function collectEvidence(root,runId,{maxFileBytes=8*1024*1024}={}) {
 const result={files:[],omitted:[]};let total=0;
 if(!fs.existsSync(root))return result;
 const walk=(dir,depth=0)=>{
  if(depth>8)return;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   if(result.files.length+result.omitted.length>=1000)return;
   const file=path.join(dir,entry.name),relative=path.relative(root,file);
   if(entry.isSymbolicLink())continue;
   if(entry.isDirectory()){walk(file,depth+1);continue;}
   if(!entry.isFile()||!allowed(entry.name))continue;
   const size=fs.statSync(file).size;
   if(size>maxFileBytes||total+size>maxTotalBytes){result.omitted.push(relative);continue;}
   const data=fs.readFileSync(file);total+=data.length;result.files.push({path:relative,data:data.toString('base64')});
  }
 };
 for(const entry of fs.readdirSync(root,{withFileTypes:true}))if(entry.isDirectory()&&(entry.name===runId||/^00[1-6]$/.test(entry.name.slice(runId.length+1))&&entry.name.startsWith(runId+'-')))walk(path.join(root,entry.name));
 return result;
}
export function saveEvidence(destination,evidence){
 if(!Array.isArray(evidence.files)||evidence.files.length>1000)throw Error('Invalid evidence files');
 fs.mkdirSync(destination,{recursive:true,mode:0o700});let total=0;
 for(const file of evidence.files){
  if(typeof file.path!=='string'||file.path.length>500||!file.path.split('/').every(p=>/^[a-zA-Z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..')||!allowed(path.basename(file.path)))throw Error('Invalid evidence path');
  if(typeof file.data!=='string'||file.data.length>12*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))throw Error('Invalid evidence data');
  const data=Buffer.from(file.data,'base64');total+=data.length;if(total>maxTotalBytes)throw Error('Evidence exceeds quota');
  const target=path.join(destination,file.path);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.writeFileSync(target,data,{flag:'wx',mode:0o600});
 }
 fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify({files:evidence.files.map(f=>f.path),omitted:evidence.omitted||[]},null,2),{flag:'wx',mode:0o600});
}
export function extractEvidence(output){
 const line=output.split('\n').filter(line=>line.startsWith('E2E_EVIDENCE_JSON:')).at(-1);
 if(!line||line.length>48*1024*1024)throw Error('Container evidence missing or too large');
 return JSON.parse(line.slice('E2E_EVIDENCE_JSON:'.length));
}
