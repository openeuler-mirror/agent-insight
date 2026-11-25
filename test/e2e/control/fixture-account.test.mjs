import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareFixtures } from '../shared/clients.mjs';

test('fixture preparation authenticates the configured existing account without weakening auth', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-auth-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const account={username:'fixture@example.invalid',apiKey:'fixture-key'};
  const ctx={root,project:fileURLToPath(new URL('../../..',import.meta.url)),baseUrl:'https://fixture.invalid',
    testUsername:account.username,account,secrets:[],stage:async(id,expected,run)=>run()};
  let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://fixture.invalid/api/auth/apikey');
    assert.equal(options.headers['x-witty-api-key'],account.apiKey);
    assert.equal(JSON.parse(options.body).username,account.username);
    calls++;return Response.json(account);
  });
  await prepareFixtures(ctx);
  assert.equal(calls,4);
  assert.deepEqual(ctx.secrets,Array(4).fill(account.apiKey));
});

test('fixture authentication failure stops preparation and exposes only HTTP status',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-auth-fail-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ctx={root,project:fileURLToPath(new URL('../../..',import.meta.url)),baseUrl:'https://fixture.invalid',
    runId:'fixture',secrets:[],stage:async(id,expected,run)=>run()};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.headers['x-witty-api-key'],undefined);
    return new Response('private diagnostic',{status:401});
  });
  await assert.rejects(prepareFixtures(ctx),/Fixture account authentication failed: HTTP 401/);
  assert.deepEqual(ctx.secrets,[]);
});
