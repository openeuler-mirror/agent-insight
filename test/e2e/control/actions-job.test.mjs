import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareActionsJob, assertJobContainer } from './actions-job.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-job-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout'), imageRoot = path.join(root, 'image');
  fs.mkdirSync(checkout);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, value); };
  for (const file of ['package-lock.json', 'test/e2e/package-lock.json', 'prisma/schema.prisma']) write(path.join(checkout, file), file);
  write(path.join(checkout, '.gitignore'), '.atomgit-e2e.*/\nnode_modules/\nexclude/\n');
  for (const [source, target] of [['package-lock.json','dependencies/package-lock.json'],['test/e2e/package-lock.json','e2e/package-lock.json'],['prisma/schema.prisma','dependencies/prisma/schema.prisma']]) write(path.join(imageRoot, target), fs.readFileSync(path.join(checkout, source)));
  for (const file of ['dependencies/node_modules/example/index.js','e2e/node_modules/playwright/index.mjs','opencode-v2/node_modules/.bin/opencode','fi-npm-cache/cache']) write(path.join(imageRoot, file), 'fixture');
  write(path.join(imageRoot, 'dependencies/node_modules/prisma/build/index.js'), "const fs=require('node:fs');fs.mkdirSync('node_modules/.prisma/client',{recursive:true});fs.copyFileSync(process.argv[4],'node_modules/.prisma/client/schema.prisma');\n");
  for (const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture']]) assert.equal(spawnSync('git',args,{cwd:checkout}).status,0);
  write(path.join(checkout, 'not-committed.key'), 'private-fixture');
  return { root, checkout, imageRoot, envFile:path.join(root, 'env'), sha:spawnSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).stdout.trim() };
}

function preparedCommand(calls = []) {
  return async (bin, args, options) => {
    calls.push({bin,args,options});
    if (bin === process.execPath) {
      const result = spawnSync(bin, args, {...options, encoding:'utf8'});
      return {code:result.status, output:result.stdout + result.stderr};
    }
    assert.equal(bin,'npm');
    assert.deepEqual(args,['run','compile','--prefix','scripts/trae-collector']);
    const generated=path.join(options.cwd,'node_modules/.prisma/client/schema.prisma');
    assert.ok(fs.existsSync(generated),'compile must wait for Prisma Client generation');
    assert.equal(fs.readFileSync(generated,'utf8'),fs.readFileSync(path.join(options.cwd,'prisma/schema.prisma'),'utf8'),'compile must use the current generated Prisma Client');
    return {code:0};
  };
}

test('Actions job starts from the exact clean commit and prepares only fixed image dependencies', async t => {
  const f = fixture(t), calls = [];
  const result = await prepareActionsJob({ ...f, phase:'case', runId:'atomgit-fixture', run:preparedCommand(calls) });
  assert.equal(result.testedSha,f.sha);
  assert.equal(fs.existsSync(path.join(result.project,'not-committed.key')),false);
  assert.equal(fs.readFileSync(path.join(f.checkout,'not-committed.key'),'utf8'),'private-fixture');
  assert.equal(spawnSync('git',['status','--porcelain'],{cwd:result.project,encoding:'utf8'}).stdout,'');
  assert.equal(fs.readFileSync(path.join(result.project,'node_modules/example/index.js'),'utf8'),'fixture');
  assert.equal(fs.realpathSync(path.join(result.project,'exclude/core-e2e/runtime/v2/node_modules')),fs.realpathSync(path.join(f.imageRoot,'opencode-v2/node_modules')));
  assert.ok(calls.some(call=>call.args.join(' ')==='run compile --prefix scripts/trae-collector'));
  const env = fs.readFileSync(f.envFile,'utf8');
  for (const entry of [`E2E_CI_SOURCE=${result.project}`,`E2E_CI_ROOT=${result.root}`,`E2E_CI_TESTED_SHA=${f.sha}`,'E2E_ISOLATED_CONTAINER=1','E2E_ATOMGIT_JOB=1']) assert.ok(env.includes(entry));
  assert.ok(!env.includes('private-fixture'));
});

test('Actions job refuses either image lock drift before running commands or publishing its environment', async t => {
  for (const lock of ['dependencies/package-lock.json','e2e/package-lock.json']) await t.test(lock,async t => {
    const f=fixture(t);fs.writeFileSync(path.join(f.imageRoot,lock),'different');
    await assert.rejects(prepareActionsJob({ ...f, phase:'build', runId:'atomgit-fixture', run:async()=>assert.fail('lock drift must abort preparation') }),/fixed image/);
    assert.equal(fs.existsSync(f.envFile),false);
  });
});

test('matching dependency locks allow an older image schema', async t => {
  const f=fixture(t);fs.writeFileSync(path.join(f.imageRoot,'dependencies/prisma/schema.prisma'),'older image schema');
  const prepared=await prepareActionsJob({...f,phase:'ut',runId:'atomgit-new-schema',run:preparedCommand()});
  assert.equal(fs.readFileSync(path.join(prepared.project,'node_modules/.prisma/client/schema.prisma'),'utf8'),fs.readFileSync(path.join(prepared.project,'prisma/schema.prisma'),'utf8'));
});

test('every runtime phase generates the checked-out Prisma Client in isolation before compilation and publication', async t => {
  const logs=[];t.mock.method(console,'log',(...args)=>logs.push(args.join(' ')));
  const inherited={ATOMGIT_TOKEN:'fixture-token',OPENAI_API_KEY:'fixture-model-key',DATABASE_URL:'file:/unrelated-fixture.db'};
  for (const [key,value] of Object.entries(inherited)) {
    const previous=process.env[key];process.env[key]=value;
    t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
  }
  for (const phase of ['build','ut','case']) await t.test(phase,async t => {
    const f=fixture(t), calls=[],execute=preparedCommand(calls);
    const prepared=await prepareActionsJob({...f,phase,runId:`atomgit-${phase}`,run:async (bin,args,options)=>{
      assert.equal(fs.existsSync(f.envFile),false,'environment must wait until all preparation succeeds');
      if(bin===process.execPath) {
        assert.deepEqual(args,['node_modules/prisma/build/index.js','generate','--schema','prisma/schema.prisma']);
        assert.ok(options.env.HOME.startsWith(path.dirname(options.cwd)+path.sep));
        assert.equal(fs.statSync(options.env.HOME).mode&0o777,0o700);
        assert.ok(options.env.DATABASE_URL.startsWith(`file:${options.env.HOME}${path.sep}`));
        assert.equal(fs.existsSync(options.env.DATABASE_URL.slice(5)),false);
        assert.equal(options.env.ATOMGIT_TOKEN,undefined);assert.equal(options.env.OPENAI_API_KEY,undefined);
        assert.equal(options.env.PRISMA_GENERATE_SKIP_AUTOINSTALL,'true');assert.equal(options.env.CHECKPOINT_DISABLE,'1');
      }
      return execute(bin,args,options);
    }});
    assert.equal(calls.length,2);assert.equal(calls[0].bin,process.execPath);assert.equal(calls[1].bin,'npm');
    assert.equal(fs.existsSync(calls[0].options.env.DATABASE_URL.slice(5)),false,'generate must not create a database');
    const published=fs.readFileSync(f.envFile,'utf8');
    assert.ok(published.includes(`E2E_CI_SOURCE=${prepared.project}`));
    assert.doesNotMatch(published,/DATABASE_URL=|HOME=|fixture-token|fixture-model-key/);
  });
  assert.equal(logs.filter(line=>/^Actions Prisma Client generation: \d+ms$/.test(line)).length,3);
});

test('Prisma generation failure aborts before TRAE compilation or environment publication', async t => {
  const f=fixture(t),calls=[];
  await assert.rejects(prepareActionsJob({...f,phase:'case',runId:'atomgit-generation-failed',run:async (bin,args)=>{
    calls.push({bin,args});return {code:1};
  }}),/Prisma Client generation failed/);
  assert.equal(calls.length,1);assert.equal(calls[0].bin,process.execPath);
  assert.equal(fs.existsSync(f.envFile),false);
});

test('TRAE compilation failure keeps the environment unpublished after generation', async t => {
  const f=fixture(t),calls=[],execute=preparedCommand(calls);
  await assert.rejects(prepareActionsJob({...f,phase:'case',runId:'atomgit-compile-failed',run:async (bin,args,options)=>{
    if(bin==='npm')return {code:1};
    return execute(bin,args,options);
  }}),/TRAE collector preparation failed/);
  assert.equal(calls.length,1);assert.equal(calls[0].bin,process.execPath);
  assert.equal(fs.existsSync(f.envFile),false);
});

test('collector needs no runtime dependency image and container guard rejects host execution', async t => {
  const f=fixture(t);
  const result=await prepareActionsJob({ ...f, imageRoot:path.join(f.root,'missing-image'), phase:'collect', runId:'atomgit-fixture', run:async()=>assert.fail('collector must not build runtime dependencies') });
  assert.ok(fs.existsSync(path.join(result.project,'package-lock.json')));
  assert.equal(fs.existsSync(path.join(result.project,'node_modules')),false);
  assert.throws(()=>assertJobContainer('0::/user.slice/session'),/Kubernetes/);
  assert.doesNotThrow(()=>assertJobContainer('12:memory:/kubepods/burstable/pod'));
});


test('fresh Actions jobs bind npm to the preloaded cache registry without relying on an earlier UT job', async t => {
  const f=fixture(t),execute=preparedCommand();let checked=false;
  const prepared=await prepareActionsJob({...f,phase:'case',runId:'atomgit-fresh-cache',run:async (bin,args,options)=>{
    const {cwd,env}=options;
    const probe=spawnSync('npm',['config','list','--json'],{cwd,env:{npm_config_registry:'https://repo.huaweicloud.com/repository/npm/',...env,npm_config_userconfig:path.join(f.root,'empty.npmrc')},encoding:'utf8'});
    assert.equal(probe.status,0,probe.stderr);const settings=JSON.parse(probe.stdout);
    assert.equal(new URL(settings.registry).origin,'https://registry.npmjs.org');assert.equal(settings.offline,true);assert.equal(settings.cache,path.join(cwd,'exclude/core-e2e/cache/npm'));
    checked=true;return execute(bin,args,options);
  }});
  assert.equal(checked,true);assert.equal(prepared.env.E2E_NPM_REGISTRY,'https://registry.npmjs.org');
});
