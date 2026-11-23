import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const fixture = String.raw`
import json,os,signal,sys,threading
from pathlib import Path
from services.storage.tests.test_fault_injection_core import FaultInjectionCoreTests
from services.storage.tests.test_trace_analytics import AnalyticsFacts
from services.storage.trace_service import TraceRuntime,create_server
case=FaultInjectionCoreTests('runTest');case.setUp()
try:
 user,run_id=sys.argv[2:4]
 case.iam.create_principal(user,user,user);case.control.create_workspace('fi-w','FI');case.iam.bind_workspace('fi-w',principal_id=user)
 session=case.iam.issue_session_for_provisioning(user)
 token=case.iam.issue_api_credential(session,'fi-w',['read','write','execute','delete'])
 service=case.service()
 service.dispatch(token,'fi-w','create',{'task':{'id':'core-task','taskKey':'core-task-01234567','name':'T','status':'queued','platform':'opencode','agent':'build','prompt':'run','workspace':'__default__','user':user,'itemsJson':'[]'},'runs':[{'id':'core-run','runId':run_id,'fiTaskId':'core-task','platform':'opencode','agent':'build','fault':'step-omission','user':user,'status':'queued','requestJson':'{}'}]},username=user)
 service.dispatch(token,'fi-w','heartbeat',{'workerId':'core-worker'},username=user)
 claimed=service.dispatch(token,'fi-w','claim',{'workerId':'core-worker','limit':1},username=user)['runs'][0]
 key=Path(case.tmp.name)/'controller';key.write_text('a'*64);key.chmod(0o600)
 facts=AnalyticsFacts()
 runtime=TraceRuntime(case.control,facts,cursor_secret=b'isolated-fi-ingress-cursor',default_workspace='fi-w',controller_key_file=key)
 server=create_server(runtime,port=0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 with os.fdopen(os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'controller':str(key),'token':token,'claimToken':claimed['claimToken']},stream)
 stopped=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopped.set());stopped.wait()
 server.shutdown();server.server_close();thread.join();runtime.close()
 assert not facts.spans and not facts.summaries and not facts.payloads,'FI collection synthesized Trace evidence'
finally:case.doCleanups()
`

export async function startIsolatedFiCore(user: string, apiKey: string, runId: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fi-ingress-core-'))
  const file = path.join(root, 'private.json')
  const child = spawn('python3', ['-u', '-c', fixture, file, user, runId], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-8192) })
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  let restore = () => {}
  const dispose = async () => {
    child.kill('SIGTERM')
    const code = await exited
    restore()
    await rm(root, { recursive: true, force: true })
    assert.equal(code, 0, stderr)
  }
  try {
    let config: { origin: string; controller: string; token: string; claimToken: string } | undefined
    const deadline = Date.now() + 20_000
    while (!config) {
      try { config = JSON.parse(await readFile(file, 'utf8')) } catch {
        if (child.exitCode !== null) throw new Error(stderr)
        assert.ok(Date.now() < deadline, 'FI core fixture timed out')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    const mapping = path.join(root, 'mapping.json')
    await writeFile(mapping, JSON.stringify({ version: 1, core_origin: config.origin, bindings: [{
      legacy_api_key_sha256: createHash('sha256').update(apiKey).digest('hex'),
      legacy_username: user, principal_id: user, workspace_id: 'fi-w', credential: config.token,
    }] }), { mode: 0o600 })
    const settings = {
      AGENT_INSIGHT_TRACE_STORAGE: 'core', AGENT_INSIGHT_STORAGE_CORE_URL: config.origin,
      AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE: config.controller,
      AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE: mapping,
    }
    const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
    restore = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    Object.assign(process.env, settings)
    return { ...config, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
