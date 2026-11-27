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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectAgentRuntimes,
  detectRuntimesWithProbe,
  resetAgentRuntimeDetectionCache,
  type AgentRuntimeProbe,
  type ExecutableResolution,
} from '@/lib/engine/agent-runtime/detect';
import {
  buildAgentRuntimeOverview,
  resolveRuntimeSelection,
} from '@/lib/engine/agent-runtime/preference';
import type { AgentRuntimeDefinition, AgentRuntimeDescriptor } from '@/lib/engine/agent-runtime/types';
import { parseVersion, satisfiesMinimum } from '@/lib/engine/agent-runtime/version';

const OPEN_CODE: AgentRuntimeDefinition = {
  id: 'opencode',
  displayName: 'OpenCode',
  envVar: 'OPENCODE_BIN',
  bundledRelativePath: 'node_modules/.bin/opencode',
  command: 'opencode',
  versionArgs: ['--version'],
  minimumVersion: '1.14.30',
  capabilities: ['session', 'tools'],
  adapterAvailable: true,
};

const PI: AgentRuntimeDefinition = {
  id: 'pi',
  displayName: 'Pi',
  envVar: 'AGENT_RUNTIME_PI_BIN',
  bundledRelativePath: 'node_modules/.bin/pi',
  command: 'pi',
  versionArgs: ['--version'],
  minimumVersion: '0.82.1',
  capabilities: ['session'],
  adapterAvailable: false,
};

function probeFor(
  resolutions: Record<string, ExecutableResolution>,
  versions: Record<string, string | null> = {},
): AgentRuntimeProbe & { calls: number } {
  const state = {
    calls: 0,
    async resolve(def: AgentRuntimeDefinition) {
      state.calls += 1;
      return resolutions[def.id] ?? { kind: 'not-found' as const, searched: [] };
    },
    async readVersion(def: AgentRuntimeDefinition, executable: string) {
      return versions[executable] ?? null;
    },
  };
  return state;
}

test('parseVersion 接受常见版本输出', () => {
  assert.deepEqual(parseVersion('1.14.39'), [1, 14, 39]);
  assert.deepEqual(parseVersion('v0.82.1'), [0, 82, 1]);
  assert.deepEqual(parseVersion('opencode 1.14.39'), [1, 14, 39]);
  assert.deepEqual(parseVersion('1.14'), [1, 14, 0]);
  assert.deepEqual(parseVersion('7'), [7, 0, 0]);
  assert.equal(parseVersion('no version here'), null);
  assert.equal(parseVersion(''), null);
});

test('satisfiesMinimum 无法解析实际版本时不视为兼容', () => {
  assert.equal(satisfiesMinimum('1.14.39', '1.14.30'), true);
  assert.equal(satisfiesMinimum('1.14.0', '1.14.30'), false);
  assert.equal(satisfiesMinimum('2.0.0', '1.14.30'), true);
  assert.equal(satisfiesMinimum('garbage', '1.14.30'), false);
  assert.equal(satisfiesMinimum(null, '1.14.30'), false);
  assert.equal(satisfiesMinimum('1.0.0', null), true);
});

test('已安装且版本兼容的运行时可用', async () => {
  const probe = probeFor(
    { opencode: { kind: 'found', path: '/opt/opencode', source: 'env' } },
    { '/opt/opencode': '1.14.39' },
  );
  const detection = await detectRuntimesWithProbe([OPEN_CODE], probe);
  const runtime = detection.runtimes[0];

  assert.equal(runtime.installed, true);
  assert.equal(runtime.source, 'env');
  assert.equal(runtime.executable, '/opt/opencode');
  assert.equal(runtime.version, '1.14.39');
  assert.equal(runtime.compatible, true);
  assert.equal(runtime.usable, true);
  assert.equal(runtime.unavailableReason, null);
  assert.deepEqual(runtime.capabilities, ['session', 'tools']);
});

test('版本低于最低要求时不可用并给出原因', async () => {
  const probe = probeFor(
    { opencode: { kind: 'found', path: '/usr/bin/opencode', source: 'path' } },
    { '/usr/bin/opencode': '1.13.0' },
  );
  const runtime = (await detectRuntimesWithProbe([OPEN_CODE], probe)).runtimes[0];

  assert.equal(runtime.compatible, false);
  assert.equal(runtime.usable, false);
  assert.deepEqual(runtime.unavailableReason, { code: 'INCOMPATIBLE', detail: '1.13.0 < 1.14.30' });
});

test('找到可执行文件但无执行适配器时不可用', async () => {
  const probe = probeFor(
    { pi: { kind: 'found', path: '/usr/local/bin/pi', source: 'path' } },
    { '/usr/local/bin/pi': '0.82.1' },
  );
  const runtime = (await detectRuntimesWithProbe([PI], probe)).runtimes[0];

  assert.equal(runtime.installed, true);
  assert.equal(runtime.compatible, true);
  assert.equal(runtime.adapterAvailable, false);
  assert.equal(runtime.usable, false);
  assert.deepEqual(runtime.unavailableReason, { code: 'NO_ADAPTER' });
  assert.deepEqual(runtime.capabilities, []);
});

test('显式配置路径不存在时不回落到其他来源', async () => {
  const probe = probeFor({
    pi: { kind: 'configured-missing', path: '/opt/pi/bin/pi' },
  });
  const runtime = (await detectRuntimesWithProbe([PI], probe)).runtimes[0];

  assert.equal(runtime.installed, false);
  assert.equal(runtime.source, 'unknown');
  assert.deepEqual(runtime.unavailableReason, { code: 'CONFIGURED_PATH_MISSING', detail: '/opt/pi/bin/pi' });
  assert.equal(runtime.usable, false);
});

test('未安装和版本不可读分别给出诊断', async () => {
  const missing = (await detectRuntimesWithProbe([OPEN_CODE], probeFor({}))).runtimes[0];
  assert.equal(missing.installed, false);
  assert.deepEqual(missing.unavailableReason, { code: 'NOT_INSTALLED', detail: 'OPENCODE_BIN' });

  const unreadable = (
    await detectRuntimesWithProbe(
      [OPEN_CODE],
      probeFor({ opencode: { kind: 'found', path: '/opt/opencode', source: 'env' } }),
    )
  ).runtimes[0];
  assert.equal(unreadable.version, null);
  assert.deepEqual(unreadable.unavailableReason, { code: 'VERSION_UNREADABLE', detail: '--version' });
  assert.equal(unreadable.usable, false);
});

test('resolveRuntimeSelection 对未知运行时明确报原因', () => {
  const runtimes = [{ id: 'opencode', usable: true, unavailableReason: null }] as unknown as AgentRuntimeDescriptor[];

  assert.deepEqual(resolveRuntimeSelection(runtimes, null), { runtimeId: null, usable: false, reason: null });
  assert.deepEqual(resolveRuntimeSelection(runtimes, 'pi'), {
    runtimeId: 'pi',
    usable: false,
    reason: { code: 'UNKNOWN_RUNTIME', detail: 'pi' },
  });
  assert.deepEqual(resolveRuntimeSelection(runtimes, 'opencode'), { runtimeId: 'opencode', usable: true, reason: null });
});

test('概览计算平台默认运行时且不回退用户偏好', async () => {
  const probe = probeFor(
    {
      opencode: { kind: 'found', path: '/opt/opencode', source: 'env' },
      pi: { kind: 'found', path: '/opt/pi', source: 'env' },
    },
    { '/opt/opencode': '1.14.39', '/opt/pi': '0.82.1' },
  );
  const detection = await detectRuntimesWithProbe([OPEN_CODE, PI], probe);
  const overview = buildAgentRuntimeOverview(detection, 'pi');

  assert.equal(overview.defaultRuntimeId, 'opencode');
  assert.equal(overview.selection.runtimeId, 'pi');
  assert.equal(overview.selection.usable, false);
  assert.deepEqual(overview.selection.reason, { code: 'NO_ADAPTER' });
});

test('检测缓存命中复用结果，force 重新探测', async () => {
  resetAgentRuntimeDetectionCache();
  const probe = probeFor(
    { opencode: { kind: 'found', path: '/opt/opencode', source: 'env' } },
    { '/opt/opencode': '1.14.39' },
  );
  const options = { probe, definitions: [OPEN_CODE] as const };

  const first = await detectAgentRuntimes(options);
  const second = await detectAgentRuntimes(options);
  assert.equal(probe.calls, 1);
  assert.equal(first, second);

  await detectAgentRuntimes({ ...options, force: true });
  assert.equal(probe.calls, 2);
  resetAgentRuntimeDetectionCache();
});
