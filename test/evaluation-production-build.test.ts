import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const { sourceFingerprint, findStandaloneApp, prepareProductionBuild, withProjectLock } = require('../scripts/lib/evaluation-production-build.cjs');

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-production-build-'));
  fs.mkdirSync(path.join(root,'src'));
  fs.writeFileSync(path.join(root,'src/page.tsx'),'first');
  fs.writeFileSync(path.join(root,'package.json'),'{}');
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

test('源码与公开构建配置变化使缓存失效，日志和运行时密钥不参与', async t => {
  const project=fixture(t);
  const env={NEXT_PUBLIC_EVALUATION_DEMO:'true',PRIVATE_KEY:'one'};
  const initial=await sourceFingerprint(project,env);
  fs.writeFileSync(path.join(project,'server.log'),'runtime');
  assert.equal(await sourceFingerprint(project,{...env,PRIVATE_KEY:'two'}),initial);
  assert.notEqual(await sourceFingerprint(project,{...env,NEXT_PUBLIC_EVALUATION_DEMO:'false'}),initial);
  fs.writeFileSync(path.join(project,'src/page.tsx'),'changed');
  assert.notEqual(await sourceFingerprint(project,env),initial);
});

test('Next 生产环境配置文件变化使旧产物失效', async t => {
  const project=fixture(t), env={NEXT_PUBLIC_EVALUATION_DEMO:'true'};
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    fs.writeFileSync(path.join(project,name),'NEXT_PUBLIC_URL_PREFIX=/before');
    const before=await sourceFingerprint(project,env);
    fs.writeFileSync(path.join(project,name),'NEXT_PUBLIC_URL_PREFIX=/after');
    assert.notEqual(await sourceFingerprint(project,env),before,name);
  }
});

test('缓存可复用，源码变化重新编译，编译失败保留上一份运行产物', async t => {
  const project=fixture(t), dataRoot=path.join(project,'data-home');
  let builds=0;
  const build=async () => {
    builds++;
    const app=path.join(project,'.next/standalone/nested/app');
    fs.mkdirSync(path.join(app,'.next'),{recursive:true});
    fs.mkdirSync(path.join(project,'.next/static'),{recursive:true});
    fs.writeFileSync(path.join(app,'server.js'),'server');
    fs.writeFileSync(path.join(app,'.next/BUILD_ID'),String(builds));
    fs.writeFileSync(path.join(app,'.next/required-server-files.json'),'{}');
    fs.writeFileSync(path.join(project,'.next/static/chunk.js'),'static-'+builds);
  };
  const options={project,dataRoot,env:{NEXT_PUBLIC_EVALUATION_DEMO:'true'},build};
  const first=await prepareProductionBuild(options);
  assert.equal(first.reused,false);
  assert.equal(fs.readFileSync(path.join(first.cwd,'.next/static/chunk.js'),'utf8'),'static-1');
  assert.equal((await prepareProductionBuild(options)).reused,true);
  assert.equal(builds,1);
  fs.writeFileSync(path.join(project,'src/page.tsx'),'second');
  const second=await prepareProductionBuild(options);
  assert.equal(second.reused,false);
  assert.notEqual(second.cwd,first.cwd);
  assert.equal(fs.existsSync(first.entry),true);
  await assert.rejects(prepareProductionBuild({...options,rebuild:true,build:async()=>{throw Error('broken build');}}),/broken build/);
  assert.equal(fs.existsSync(second.entry),true);
});

test('寻找真实应用目录，忽略依赖中的同名 server.js', async t => {
  const project=fixture(t), standalone=path.join(project,'standalone');
  fs.mkdirSync(path.join(standalone,'node_modules/fake'),{recursive:true});
  fs.writeFileSync(path.join(standalone,'node_modules/fake/server.js'),'fake');
  await assert.rejects(findStandaloneApp(standalone),/standalone/);
});

test('同一仓库启动锁阻止两个命令同时编译', async t => {
  const project=fixture(t);
  await withProjectLock(project,async()=>{
    await assert.rejects(withProjectLock(project,async()=>{}),/正在启动或构建/);
  });
  await withProjectLock(project,async()=>{});
});

test('构建命令被强制终止后，下次启动可恢复陈旧锁', async t => {
  const project=fixture(t);
  const modulePath=path.resolve(__dirname,'../scripts/lib/evaluation-production-build.cjs');
  const child=spawn(process.execPath,['-e',`require(${JSON.stringify(modulePath)}).withProjectLock(${JSON.stringify(project)},()=>{console.log('locked');return new Promise(()=>{});});`],{stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));
  await once(child.stdout,'data');
  child.kill('SIGKILL');
  await once(child,'exit');
  await withProjectLock(project,async()=>{});
});
