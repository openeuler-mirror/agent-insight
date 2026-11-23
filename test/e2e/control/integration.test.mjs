import {loadExecutionConfig,configSnapshot} from '../shared/config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { Queue } from './queue.mjs';
import { createReceiver } from './receiver.mjs';
import { AtomGit } from './atomgit.mjs';
import { runQueuedJob, validateReport } from './worker-core.mjs';
import { publishResult } from './publish.mjs';
import { command } from '../shared/runtime.mjs';

test('local pipeline: signed HTTP -> queue -> real child UT/suite -> honest BLOCKED -> HTTP PR comment',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-pipeline-'));
 const project=path.join(dir,'fixture-project');fs.mkdirSync(path.join(project,'test/e2e/shared'),{recursive:true});
 for(const file of ['run.mjs','shared/runtime.mjs','shared/container-cleanup.mjs','shared/ut-environment.mjs','shared/lane.mjs','shared/suite.mjs','shared/catalog.mjs','shared/core.mjs','shared/selection.mjs','shared/config.mjs','config.json'])fs.copyFileSync(new URL('../'+file,import.meta.url),path.join(project,'test/e2e',file));
 fs.mkdirSync(path.join(project,'test/e2e/control'),{recursive:true});fs.writeFileSync(path.join(project,'test/e2e/control/build-preflight.mjs'),"export async function compileProduction(config,options){if(options?.project!==process.cwd()||!options.runId||options.env.E2E_SUITE_RUN_ID!==options.runId)throw Error('Direct suite identity was not forwarded');return {status:'PASS',buildId:'fixture'}}");
 fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({scripts:{test:'node --test fixture.test.mjs'}}));
 fs.writeFileSync(path.join(project,'fixture.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('pipeline fixture only',()=>{assert.equal(2+2,4);assert.equal(process.env.E2E_ISOLATED_CONTAINER,'0');assert.equal(process.env.npm_config_cache,'/tmp/e2e-fixture-cache');assert.equal(process.env.AGENT_INSIGHT_RAS_PYTHON,'/opt/e2e-python/bin/python3');});\n");
 fs.writeFileSync(path.join(project,'.gitignore'),'exclude/\n');
 const env={PATH:process.env.PATH,HOME:dir,GIT_CONFIG_NOSYSTEM:'1',E2E_ISOLATED_CONTAINER:'0',npm_config_cache:'/tmp/e2e-fixture-cache',AGENT_INSIGHT_RAS_PYTHON:'/opt/e2e-python/bin/python3'};
 const git=args=>{const r=spawnSync('git',args,{cwd:project,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git(['init','-q']);git(['add','.']);git(['-c','user.name=Pipeline Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','test fixture']);const sha=git(['rev-parse','HEAD']);
 const configFile=path.join(project,'test/e2e/config.json'),raw=JSON.parse(fs.readFileSync(configFile));raw.defaults.caseModes={};raw.profiles.pr.mode='mock';raw.profiles.pr.model={baseUrl:'https://gateway.example/v1',modelName:'fixture-model',options:{}};fs.writeFileSync(configFile,JSON.stringify(raw));git(['add','.']);git(['-c','user.name=Pipeline Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','configure fixture']);const configuredSha=git(['rev-parse','HEAD']);const executionConfig=loadExecutionConfig({file:configFile});
 const pr={number:1,state:'open',head:{sha:configuredSha,repo:{full_name:'gyctl/agent-insight'}},base:{sha:configuredSha,repo:{full_name:'gyctl/agent-insight'}}};
 const comments=[];const apiServer=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;res.setHeader('content-type','application/json');
  if(req.url.endsWith('/pulls/1'))return res.end(JSON.stringify(pr));
  if(req.method==='POST'){const c={id:10,...JSON.parse(raw)};comments.push(c);return res.end(JSON.stringify(c));}
  res.end(JSON.stringify(req.url.includes('/comments/10')?comments[0]:comments));
 });
 await new Promise(r=>apiServer.listen(0,'127.0.0.1',r));
 const api=new AtomGit({token:'pipeline-fixture-token',baseUrl:'http://127.0.0.1:'+apiServer.address().port,localTest:true});
 const queue=new Queue(path.join(dir,'queue.sqlite'));const secret='pipeline-fixture-signature';
 const receiver=createReceiver({secret,mode:'mock',executionConfig,repository:'gyctl/agent-insight',queue,readPull:(repo,n)=>api.readPull(repo,n)});
 await new Promise(r=>receiver.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>receiver.close(r));await new Promise(r=>apiServer.close(r));queue.close();fs.rmSync(dir,{recursive:true,force:true});});
 const body=JSON.stringify({object_kind:'merge_request',object_attributes:{iid:1,state:'opened',action:'open',target:{path_with_namespace:'gyctl/agent-insight'},last_commit:{id:configuredSha}}});
 const response=await fetch('http://127.0.0.1:'+receiver.address().port+'/webhook',{method:'POST',headers:{'content-type':'application/json','x-gitcode-signature-256':'sha256='+createHmac('sha256',secret).update(body).digest('hex')},body});assert.equal(response.status,202);
 const job=queue.claim();const outcome=await runQueuedJob(job,{readPull:(repo,n)=>api.readPull(repo,n),isCurrent:()=>queue.get(job.id).state==='RUNNING',execute:async()=>{
  const run=await command(process.execPath,['test/e2e/run.mjs','--mode','mock','--ut','--run-id','pr-'+job.id],{cwd:project,env,timeout:30000});
  assert.equal(run.code,1);
  const report=JSON.parse(fs.readFileSync(path.join(project,'exclude/core-e2e','pr-'+job.id,'report.json')));
  assert.equal(report.npmTest.status,'PASS');assert.equal(report.npmTest.observedSummary.tests,1);
  assert.equal(report.scenarios.filter(s=>s.status==='BLOCKED').length,5);
  assert.equal(report.configuration.hash,configSnapshot(executionConfig).hash);assert.equal(report.configuration.settings.model.modelName,'fixture-model');assert.equal(report.scenarios.find(s=>s.id==='005').status,'BLOCKED');
  return validateReport(report,{job,testedSha:configuredSha,exitCode:run.code});
 }});
 assert.equal(outcome.state,'COMPLETED');assert.equal(outcome.result.status,'BLOCKED');queue.finish(job.id,outcome.state,outcome.result);
 assert.equal((await publishResult(api,job,outcome.result)).status,'PUBLISHED');assert.equal(comments.length,1);
 assert.ok(comments[0].body.includes('阻塞'));assert.ok(comments[0].body.includes('UT：通过'));
});
