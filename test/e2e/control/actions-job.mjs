import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { command } from '../shared/runtime.mjs';

export function assertJobContainer(cgroup = fs.readFileSync('/proc/self/cgroup','utf8')) {
  assert.match(cgroup,/kubepods/,'Actions execution requires a Kubernetes Job container');
}

function git(cwd,args) {
  const result=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||'Git source preparation failed');return result.stdout.trim();
}

export async function prepareActionsJob({checkout=process.cwd(),imageRoot='/opt',envFile=process.env.ATOMGIT_ENV,phase,runId,expectedSha,run=command}) {
  assert.ok(['build','ut','case','collect'].includes(phase),'Unknown Actions job phase');
  assert.match(runId||'',/^[a-z0-9-]{1,80}$/,'Invalid Actions run ID');
  assert.ok(path.isAbsolute(envFile||''),'Actions environment file is required');
  const testedSha=git(checkout,['rev-parse','HEAD']);
  if(expectedSha)assert.equal(testedSha,expectedSha,'Job checked out a different source commit');
  const root=fs.mkdtempSync(path.join(checkout,'.atomgit-e2e.')),project=path.join(root,'source');
  fs.mkdirSync(project);git(project,['init','-q']);git(project,['fetch','--no-tags','--depth=1',checkout,testedSha]);git(project,['checkout','--detach',testedSha]);
  const env={E2E_CI_ROOT:root,E2E_CI_SOURCE:project,E2E_CI_TESTED_SHA:testedSha,E2E_CI_RUN_ID:runId,E2E_ISOLATED_CONTAINER:'1',E2E_ATOMGIT_JOB:'1'};
  if(phase!=='collect') {
    const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    for(const [source,image] of [['package-lock.json','dependencies/package-lock.json'],['test/e2e/package-lock.json','e2e/package-lock.json']]) {
      assert.equal(hash(path.join(project,source)),hash(path.join(imageRoot,image)),`${source} differs from the fixed image; rebuild the image`);
    }
    fs.cpSync(path.join(imageRoot,'dependencies/node_modules'),path.join(project,'node_modules'),{recursive:true,verbatimSymlinks:true});
    fs.cpSync(path.join(imageRoot,'e2e/node_modules'),path.join(project,'test/e2e/node_modules'),{recursive:true,verbatimSymlinks:true});
    fs.mkdirSync(path.join(project,'exclude/core-e2e/runtime/v2'),{recursive:true});
    fs.symlinkSync(path.join(imageRoot,'opencode-v2/node_modules'),path.join(project,'exclude/core-e2e/runtime/v2/node_modules'));
    const cache=path.join(project,'exclude/core-e2e/cache/npm');
    fs.cpSync(path.join(imageRoot,'fi-npm-cache'),cache,{recursive:true,verbatimSymlinks:true});
    Object.assign(env,{PLAYWRIGHT_BROWSERS_PATH:path.join(imageRoot,'browsers'),E2E_BROWSER_CHANNEL:'chromium',E2E_PYTHON:'/usr/bin/python3',AGENT_INSIGHT_RAS_PYTHON:path.join(imageRoot,'e2e-python/bin/python'),E2E_NPM_OFFLINE:'1',E2E_PREPARED_PLUGIN_DIR:path.join(imageRoot,'ras-plugin'),PIP_NO_INDEX:'1',PIP_FIND_LINKS:path.join(imageRoot,'wheels'),npm_config_cache:cache,npm_config_registry:'https://registry.npmjs.org',E2E_NPM_REGISTRY:'https://registry.npmjs.org',npm_config_offline:'true'});
    const home=path.join(root,'prisma-home');fs.mkdirSync(home,{mode:0o700});
    const started=performance.now();
    const generated=await run(process.execPath,['node_modules/prisma/build/index.js','generate','--schema','prisma/schema.prisma'],{cwd:project,env:{PATH:process.env.PATH,...env,HOME:home,DATABASE_URL:`file:${path.join(home,'generate-only.db')}`,PRISMA_GENERATE_SKIP_AUTOINSTALL:'true',CHECKPOINT_DISABLE:'1'},timeout:120000});
    console.log(`Actions Prisma Client generation: ${Math.round(performance.now()-started)}ms`);
    assert.equal(generated.code,0,'Prisma Client generation failed');
    const built=await run('npm',['run','compile','--prefix','scripts/trae-collector'],{cwd:project,env:{PATH:process.env.PATH,...env},timeout:120000});
    assert.equal(built.code,0,'TRAE collector preparation failed');
  }
  fs.appendFileSync(envFile,Object.entries(env).map(([key,value])=>`${key}=${value}\n`).join(''));
  return {root,project,testedSha,env};
}

export async function verifyActionsRuntime({project,imageRoot='/opt',run=command,env=process.env}) {
  if(spawnSync('ps',['-eo','pid=,ppid='],{stdio:'ignore'}).status!==0) {
    for(const args of [['-o','Acquire::Retries=2','-o','Acquire::http::Timeout=30','update'],['-o','Acquire::Retries=2','-o','Acquire::http::Timeout=30','install','-y','--no-install-recommends','procps']]) {
      const installed=await run('apt-get',args,{cwd:project,env,timeout:180000});assert.equal(installed.code,0,'Process cleanup tools unavailable');
    }
  }
  for(const [bin,args] of [['python3',['--version']],[path.join(imageRoot,'e2e-python/bin/python'),['-c','import yaml, pydantic; print("RAS Python dependencies ready")']],['pwsh',['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()']]]) {
    const checked=await run(bin,args,{cwd:project,env,timeout:60000});assert.equal(checked.code,0,'Required native tool unavailable');
  }
  const script="import assert from 'node:assert/strict';import {chromium} from './test/e2e/node_modules/playwright/index.mjs';const browser=await chromium.launch({channel:'chromium',headless:true});try{const page=await browser.newPage();await page.goto('data:text/html,<title>Agent Insight CI</title>');assert.equal(await page.title(),'Agent Insight CI');console.log('Chromium smoke passed:',browser.version());}finally{await browser.close();}";
  const browser=await run(process.execPath,['--input-type=module','-e',script],{cwd:project,env,timeout:60000});assert.equal(browser.code,0,'Preinstalled Chromium unavailable');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {values}=parseArgs({options:{phase:{type:'string'},'run-id':{type:'string'},'verify-runtime':{type:'boolean'}}});
    assertJobContainer();
    if(values['verify-runtime'])await verifyActionsRuntime({project:process.env.E2E_CI_SOURCE});
    else {
      const prepared=await prepareActionsJob({phase:values.phase,runId:values['run-id'],expectedSha:process.env.E2E_EXPECTED_SHA});
      console.log('Actions job prepared:',JSON.stringify({phase:values.phase,testedSha:prepared.testedSha,runId:values['run-id']}));
    }
  } catch(error) {console.error('Actions job preparation failed:',error.message);process.exitCode=1;}
}
