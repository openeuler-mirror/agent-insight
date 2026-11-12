import fs from 'node:fs';import path from 'node:path';
import {prepareProductionBuild} from '../shared/application.mjs';import {boundedAppEnv} from '../shared/app-environment.mjs';import {command} from '../shared/runtime.mjs';import {sourceFingerprint} from '../shared/build-artifact.mjs';
export async function compileProduction(config,{project=process.cwd(),runId=process.env.E2E_RUN_ID,env:inputEnv=process.env,run=command}={}){
 const root=path.join(project,'exclude/core-e2e/build-preflight');fs.mkdirSync(path.join(root,'private'),{recursive:true,mode:0o700});
 const startedAt=new Date().toISOString(),fingerprint=sourceFingerprint(project),log=path.join(root,'private/production-build.log');
 const env=boundedAppEnv(root,{...inputEnv,E2E_SUITE_RUN_ID:runId,HOME:path.join(root,'host'),AGENT_INSIGHT_HOME:path.join(root,'app'),DATABASE_URL:'file:'+path.join(root,'app/data/witty_insight.db'),LOGIN_MODE:'standalone'},config.resources);
 let result;
 try {
  for(const [bin,args] of [['node',['-e',"const u=require('./scripts/utils.js');u.ensureEnvFile();u.ensureDataDirectory()"]],['node',['scripts/prepare-ras-sqlite-schema.js']],['sh',['scripts/db_push.sh','--skip-generate']],['node',['node_modules/prisma/build/index.js','generate']]]) {
   const execution=await run(bin,args,{cwd:project,env,log,timeout:120000});if(execution.code!==0)throw Error('Production build preparation failed: '+[bin,...args.slice(0,1)].join(' '));
  }
  const built=await prepareProductionBuild({project,root,runId},env,{run});
  result={status:'PASS',exitCode:0,buildId:built.buildId};
 }catch(error){result={status:'FAIL',exitCode:1,reason:error.message};}
 const endedAt=new Date().toISOString();result={...result,startedAt,endedAt,durationMs:Date.parse(endedAt)-Date.parse(startedAt),sourceFingerprint:fingerprint,command:'npm run build -- --webpack',log:'build/private-build/production-build.log'};
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(result,null,2));return result;
}
