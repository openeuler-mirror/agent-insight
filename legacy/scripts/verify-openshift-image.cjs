#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

function docker(args, timeout = 30_000) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }).trim();
}

async function waitReady(name, port = 3000) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    assert.equal(docker(['inspect', '--format', '{{.State.Running}}', name]), 'true', 'application container exited');
    try {
      return JSON.parse(docker(['exec', name, 'node', '-e',
        `fetch('http://127.0.0.1:${port}/').then(async r=>{if(r.status!==200)process.exit(1);const body=await r.text();if(!body.length)process.exit(1);console.log(JSON.stringify({status:r.status,contentType:r.headers.get('content-type')}))}).catch(()=>process.exit(1))`], 10_000));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error('application did not become ready within 180 seconds');
}

async function verify(image) {
  const metadata = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.ok(['', '0', '0:0', 'root'].includes(metadata.Config.User || ''), 'delivery image must inherit UID 0 for no-USER patch builds');
  const pythonProbe = "from enum import StrEnum; from dataclasses import make_dataclass; import json, platform, sys, yaml, pydantic; make_dataclass('Probe', [('value', str)], slots=True); assert yaml.safe_load('marker: ok')['marker'] == 'ok'; sys.path.insert(0, '/app/node_modules/agent-insight'); from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry; faults = list(FaultRegistry().names()); assert faults; sys.path.insert(0, '/app/node_modules/agent-insight/agent_ras'); from detectors.catalog import build_capability_catalog; domains = build_capability_catalog()['domains']; assert any(d['id'] == 'llm_thinking_loop' for d in domains); print(json.dumps({'version': platform.python_version(), 'pyyaml': yaml.__version__, 'pydantic': pydantic.__version__, 'faults': len(faults), 'rasDomains': len(domains)}))";
  const platform = JSON.parse(docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
    `const fs=require('fs');const {execFileSync}=require('child_process');const release=fs.readFileSync('/etc/os-release','utf8');const python=JSON.parse(execFileSync('python3',['-c',${JSON.stringify(pythonProbe)}],{encoding:'utf8'}));console.log(JSON.stringify({uid:process.getuid(),release,dnf:execFileSync('dnf',['--version'],{encoding:'utf8'}).split(String.fromCharCode(10))[0],node:process.version,python:python.version,pyyaml:python.pyyaml,faults:python.faults}))`]));
  assert.equal(platform.uid, 0);
  assert.match(platform.release, /^ID="?rhel"?$/m);
  assert.match(platform.release, /^VERSION_ID="?9(?:\.|"|$)/m);
  assert.ok(platform.dnf, 'full dnf must be executable');

  const results = [];
  for (const uid of [1000730000, 1000840000]) {
    const name = `insight-ocp-check-${randomUUID()}`;
    const volume = `${name}-data`;
    let volumeCreated = false;
    try {
      docker(['volume', 'create', '--label', 'agent-insight.test=openshift-image', volume]);
      volumeCreated = true;
      docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${volume},dst=/data/agent-insight`,
        '--entrypoint', '/bin/sh', image, '-ec', 'chgrp 0 /data/agent-insight && chmod 0770 /data/agent-insight']);
      docker(['run', '-d', '--name', name, '--network', 'none', '--user', `${uid}:0`,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '4g', '--cpus', '2',
        '--mount', `type=volume,src=${volume},dst=/data/agent-insight`, image]);
      const http = await waitReady(name);
      const apiRoutes = JSON.parse(docker(['exec', name, 'node', '-e', `
        (async()=>{const rows=[];for(const [route,method,body,statuses] of [
          ['/api/eval/settings/test','POST',{testTimeoutMs:0},[400]],
          ['/api/observe/data','GET',null,[200,400,401,403]],
          ['/api/admin/usage/features/trace','GET',null,[401,403]],
          ['/api/observe/infra/sources/test','GET',null,[400]]
        ]){const r=await fetch('http://127.0.0.1:3000'+route,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!statuses.includes(r.status))throw Error(route+' unexpected HTTP '+r.status);if(method==='POST'){const d=await r.json();if(d.code!=='invalid_request')throw Error('Model validation contract missing');}if(route==='/api/observe/infra/sources/test'&&(await r.json()).error!=='Missing endpoint')throw Error('Infra validation contract missing');rows.push({route,status:r.status});}console.log(JSON.stringify(rows));})().catch(e=>{console.error(e.message);process.exit(1)});
      `]));
      const runtime = JSON.parse(docker(['exec', name, 'node', '-e',
        "const fs=require('fs');for(const key of ['HOME','XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME']){const p=process.env[key];if(!p||!p.startsWith('/data/agent-insight'))throw Error('invalid '+key);fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/.write-check','ok')}console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),home:require('os').homedir()}))"]));
      assert.equal(runtime.uid, uid);
      assert.equal(runtime.gid, 0);
      const pythonRuntime = JSON.parse(docker(['exec', name, 'python3', '-c', pythonProbe]));
      const rasSchema = JSON.parse(docker(['exec', name, 'node', '-e',
        "fetch('http://127.0.0.1:3000/api/reliability/config-schemas/opencode').then(r=>{if(!r.ok)throw Error('RAS schema HTTP '+r.status);return r.json()}).then(s=>{const fields=s.sections.flatMap(section=>section.fields).map(field=>field.key);if(!fields.includes('detectors.llm_thinking_loop.enabled'))throw Error('RAS thinking-loop configuration missing');console.log(JSON.stringify({fields:fields.length,thinkingLoop:true}))}).catch(e=>{console.error(e.message);process.exit(1)})"]));
      const controlGateway = JSON.parse(docker(['exec', name, 'node', '-e', `
        const {connectWebSocket}=require('/app/node_modules/agent-insight/scripts/ws-client.cjs');
        const base='http://127.0.0.1:3000';
        async function request(route,body,key){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(key?{'x-witty-api-key':key}:{})},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(route+' HTTP '+r.status);return d;}
        (async()=>{const account=await request('/api/auth/apikey',{username:'test_image_gateway_${uid}@example.invalid'});const token=await request('/api/reliability/install-tokens',{expiresInSeconds:600},account.apiKey);const client=await request('/api/reliability/client/v1/register',{installToken:token.installToken,client:{name:'restricted-image-gateway-check',os:'linux',arch:process.arch,agentVersion:'validation',machineId:'image-check-${uid}'},capabilities:{platforms:[],actions:[]}},account.apiKey);const ws=await connectWebSocket('ws://127.0.0.1:3000/api/reliability/client/v1/control',{headers:{authorization:'Bearer '+client.deviceCredential,'x-agent-insight-client-id':client.clientId}});ws.close();console.log(JSON.stringify({websocket:true,uid:process.getuid()}));setTimeout(()=>process.exit(0),100);})().catch(e=>{console.error(e.message);process.exit(1)});
      `], 30_000));
      const opencode = docker(['exec', name, '/app/node_modules/.bin/opencode', '--version']);
      docker(['exec', '-d', name, '/app/node_modules/.bin/opencode', 'serve', '--hostname', '127.0.0.1', '--port', '46991']);
      const opencodeHttp = await waitReady(name, 46991);
      const database = docker(['exec', '-e', 'DATABASE_URL=file:/data/agent-insight/data/witty_insight.db', name,
        'node', '-e', "const {PrismaClient}=require('/app/node_modules/@prisma/client');const p=new PrismaClient();p.$queryRawUnsafe('SELECT COUNT(*) AS n FROM sqlite_master').then(r=>{if(!r[0].n)throw Error('empty schema');console.log('schema ready')}).finally(()=>p.$disconnect())"]);
      assert.equal(database, 'schema ready');
      docker(['exec', name, 'node', '-e', "require('fs').writeFileSync('/data/agent-insight/persistent-marker','preserved')"]);
      docker(['restart', '--time', '15', name]);
      await waitReady(name);
      assert.equal(docker(['exec', name, 'node', '-e',
        "const fs=require('fs');if(fs.readFileSync('/data/agent-insight/persistent-marker','utf8')!=='preserved'||!fs.statSync('/data/agent-insight/data/witty_insight.db').size)process.exit(1);console.log('persistent')"]), 'persistent');
      results.push({ uid, gid: runtime.gid, http, apiRoutes, python: pythonRuntime, rasSchema, controlGateway, opencode, opencodeHttp, database, restart: 'passed' });
    } catch (error) {
      try { process.stderr.write(docker(['logs', '--tail', '80', name]) + '\n'); } catch { /* container may not exist */ }
      throw error;
    } finally {
      try { docker(['rm', '-f', name]); } catch { /* container may not exist */ }
      if (volumeCreated) docker(['volume', 'rm', volume]);
    }
  }
  return { image, id: metadata.Id, architecture: metadata.Architecture, defaultUser: metadata.Config.User || '0', platform, results,
    scope: 'Local restricted-container simulation; live OpenShift SCC, PVC, Route and business acceptance require separate validation.' };
}

if (require.main === module) {
  const image = process.argv[2];
  if (!image) {
    process.stderr.write('Usage: node scripts/verify-openshift-image.cjs IMAGE\n');
    process.exitCode = 2;
  } else {
    verify(image).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });
  }
}

module.exports = { verify };
