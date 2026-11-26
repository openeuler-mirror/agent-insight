import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareFixtures } from '../shared/clients.mjs';

test('fixture preparation uses the upstream managed account and password-change flow', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-auth-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const account={username:'fixture@example.invalid',apiKey:'fixture-key'};
  fs.writeFileSync(path.join(root,'.admin_api_key'),'fixture-admin-key');
  const ctx={root,project:fileURLToPath(new URL('../../..',import.meta.url)),baseUrl:'https://fixture.invalid',
    appHome:root,runId:'fixture-run',testUsername:account.username,account,secrets:[],stage:async(id,expected,run)=>run()};
  let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const body=JSON.parse(options.body);
    calls++;
    if(url.endsWith('/api/admin/accounts')) {
      assert.equal(options.headers['x-witty-api-key'],'fixture-admin-key');
      assert.equal(body.username,account.username);
      assert.ok(body.password.startsWith('E2eTemp-'));
      return new Response(null,{status:409});
    }
    if(url.endsWith('/reset-password')) {
      assert.equal(options.headers['x-witty-api-key'],'fixture-admin-key');
      assert.ok(body.password.startsWith('E2eTemp-'));
      return Response.json({});
    }
    if(url.endsWith('/api/auth/apikey')) {
      assert.equal(body.username,account.username);
      assert.ok(body.password.startsWith('E2eTemp-'));
      return Response.json({passwordChangeRequired:true,passwordSetupToken:'fixture-setup-token'});
    }
    assert.equal(url,'https://fixture.invalid/api/auth/password');
    assert.equal(options.headers['x-witty-password-token'],'fixture-setup-token');
    assert.ok(body.newPassword.startsWith('E2eFinal-'));
    return Response.json(account);
  });
  await prepareFixtures(ctx);
  assert.equal(calls,16);
  assert.equal(ctx.secrets.length,12);
  for(let i=0;i<4;i++) {
    assert.equal(ctx.secrets[i*3+2],account.apiKey);
    const saved=JSON.parse(fs.readFileSync(path.join(root,'private',`account-00${i+2}.json`),'utf8'));
    assert.equal(saved.apiKey,account.apiKey);
    assert.ok(saved.password.startsWith('E2eFinal-'));
  }
});

test('fixture account provisioning failure stops before login and persistence',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-auth-fail-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'.admin_api_key'),'fixture-admin-key');
  const ctx={root,project:fileURLToPath(new URL('../../..',import.meta.url)),baseUrl:'https://fixture.invalid',
    appHome:root,runId:'fixture',secrets:[],stage:async(id,expected,run)=>run()};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://fixture.invalid/api/admin/accounts');
    assert.equal(options.headers['x-witty-api-key'],'fixture-admin-key');
    return new Response('private diagnostic',{status:403});
  });
  await assert.rejects(prepareFixtures(ctx),/Unable to create test account .*: 403/);
  assert.deepEqual(ctx.secrets,[]);
  assert.equal(fs.existsSync(path.join(root,'private')),false);
});
