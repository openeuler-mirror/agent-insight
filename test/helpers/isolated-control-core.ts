import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {withCoreControlRequest} from '@/lib/storage-core/control-context';

const fixture = String.raw`
import json,os,signal,sys,threading
from pathlib import Path
from services.storage.control import SQLiteControlStore
from services.storage.iam import IAMStore
from services.storage.tests.test_trace_analytics import AnalyticsFacts
from services.storage.trace_service import TraceRuntime,create_server
class Facts(AnalyticsFacts):
    def __init__(self):
        super().__init__();self.dataset_rows={}
    def _insert(self,table,rows):
        if table in ('dataset_sample_revisions','dataset_release_members'):
            self.dataset_rows.setdefault(table,[]).extend(rows)
        else:super()._insert(table,rows)
root=Path(sys.argv[1]);control=SQLiteControlStore(root/'control.db');control.initialize();iam=IAMStore(control)
tokens={}
for entry in json.loads(sys.argv[2]):
    user=entry if isinstance(entry,str) else entry['username'];principal=user if isinstance(entry,str) else entry['principal'];workspace=user if isinstance(entry,str) else entry['workspace']
    iam.create_principal(principal,user,user);control.create_workspace(workspace,user);iam.bind_workspace(workspace,principal_id=principal)
    session=iam.issue_session_for_provisioning(principal)
    tokens[user]=iam.issue_api_credential(session,workspace,['read','write','execute','publish','delete'])
key=root/'controller';key.write_text('a'*64);key.chmod(0o600)
runtime=TraceRuntime(control,Facts(),cursor_secret=b'isolated-control-test-cursor',default_workspace=next(iter(tokens)),controller_key_file=key)
if sys.argv[3]=='worker':runtime.start_worker()
server=create_server(runtime,port=0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
    with os.fdopen(os.open(root/'private.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:
        json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'controller':str(key),'tokens':tokens},stream)
    stopped=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopped.set());stopped.wait()
finally:
    server.shutdown();server.server_close();thread.join();runtime.close()
`;

export async function startIsolatedControlCore(users: Array<string | {username:string;principal:string;workspace:string}>, options: {worker?:boolean} = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'control-core-test-')));
  const child = spawn('python3', ['-u', '-c', fixture, root, JSON.stringify(users), options.worker ? 'worker' : 'control-only'], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-8192); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  let restore = () => {};
  const dispose = async () => {
    child.kill('SIGTERM');
    const code = await exited;
    restore();
    await rm(root, {recursive: true, force: true});
    assert.equal(code, 0, stderr);
  };
  try {
    let config: {origin: string; controller: string; tokens: Record<string, string>} | undefined;
    const deadline = Date.now() + 20_000;
    while (!config) {
      try { config = JSON.parse(await readFile(path.join(root, 'private.json'), 'utf8')); }
      catch {
        if (child.exitCode !== null) throw Error(stderr);
        assert.ok(Date.now() < deadline, 'Control Core fixture timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const settings = {
      AGENT_INSIGHT_HOME: root,
      AGENT_INSIGHT_TRACE_STORAGE: 'core',
      AGENT_INSIGHT_STORAGE_CORE_URL: config.origin,
      AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE: config.controller,
    };
    const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    restore = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    };
    Object.assign(process.env, settings);
    const resolved = config;
    return {
      ...resolved, root, dispose,
      request(user: string) {
        assert.ok(resolved.tokens[user], 'Unknown fixture owner');
        return new Request('http://localhost/internal/control-test', {
          headers: {authorization: 'Bearer ' + resolved.tokens[user]},
        });
      },
      run<T>(user: string, action: () => Promise<T>) {
        return withCoreControlRequest(this.request(user), action);
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
