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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function wire(mode: string) {
  const script = String.raw`
import asyncio, importlib.util, json, os, sys, types
os.environ['OTEL_ENABLED'] = 'true'
os.environ['AGENT_INSIGHT_OTLP_ENDPOINT'] = 'http://localhost:3000/api/ingest/otel/v1/traces'
state = {'initialized': '${mode}' == 'existing', 'calls': [], 'tracing': False}
class Config:
    def __init__(self, **kw): self.__dict__.update(kw)
def init(config):
    state['calls'].append('init')
    state['initialized'] = True
def shutdown():
    state['calls'].append('shutdown')
    state['initialized'] = False
team = types.ModuleType('openjiuwen.agent_teams.observability')
team.ObservabilityConfig = Config
team.init_observability = init
team.shutdown_observability = shutdown
team.is_initialized = lambda: state['initialized']
sys.modules[team.__name__] = team
if '${mode}' != 'legacy':
    harness = types.ModuleType('openjiuwen.harness.observability')
    def acquire(config):
        state['calls'].append('acquire')
        if '${mode}' == 'failure': raise RuntimeError('agent tracing unavailable')
        state['tracing'] = True
        return True
    def release():
        state['calls'].append('release')
        state['tracing'] = False
    harness.acquire_observability = acquire
    harness.release_observability = release
    sys.modules[harness.__name__] = harness
spec = importlib.util.spec_from_file_location('insight_extension', 'scripts/jiuwen_extension/extension.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
async def main():
    extensions = await module.register_extensions(None)
    extension = extensions[0]
    state['wired'] = extension._initialized
    state['tracing_after_wire'] = state['tracing']
    await extension.shutdown()
asyncio.run(main())
print('RESULT=' + json.dumps(state))
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RESULT='))!.slice(7));
}

test('Jiuwen extension activates newer single-agent tracing in addition to the exporter', () => {
  const result = wire('current');
  assert.equal(result.wired, true);
  assert.equal(result.tracing_after_wire, true);
  assert.deepEqual(result.calls, ['init', 'acquire', 'release', 'shutdown']);
});

test('Jiuwen extension retains the older SDK initialization path', () => {
  const result = wire('legacy');
  assert.equal(result.wired, true);
  assert.deepEqual(result.calls, ['init', 'shutdown']);
});

test('Jiuwen extension enables tracing when reusing a provider without shutting down its owner', () => {
  const result = wire('existing');
  assert.equal(result.tracing_after_wire, true);
  assert.equal(result.initialized, true);
  assert.deepEqual(result.calls, ['acquire', 'release']);
});

test('Jiuwen extension does not report successful onboarding after agent tracing acquisition fails', () => {
  const result = wire('failure');
  assert.equal(result.wired, false);
  assert.equal(result.initialized, false);
});
