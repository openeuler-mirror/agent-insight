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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildVersionProbeCommand,
    detectAgentRuntimes,
    findOnPath,
    invalidateAgentRuntimeDetection,
    type AgentRuntimeExecutable,
} from '@/lib/agent-runtime';
import { compareRuntimeVersions, parseRuntimeVersion } from '@/lib/agent-runtime/types';

const NOW = () => Date.parse('2026-11-09T00:00:00.000Z');

function executable(id: 'pi' | 'opencode', path = `/opt/${id}/bin/${id}`): AgentRuntimeExecutable {
    return { path, source: 'environment' };
}

function probeEnv(values: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { NODE_ENV: 'test', ...values };
}

test.beforeEach(() => invalidateAgentRuntimeDetection());

test('reports a runtime that is not installed with an explicit reason', async () => {
    const detection = await detectAgentRuntimes({
        forceRefresh: true,
        now: NOW,
        resolveExecutable: () => null,
        probeVersion: async () => '9.9.9',
    });
    const pi = detection.runtimes.find(item => item.id === 'pi')!;
    assert.equal(pi.status, 'not-installed');
    assert.equal(pi.selectable, false);
    assert.equal(pi.executable, null);
    assert.equal(pi.diagnostics[0].code, 'RUNTIME_NOT_INSTALLED');
});

test('detected but unimplemented runtime is adapter-missing and not selectable', async () => {
    const detection = await detectAgentRuntimes({
        forceRefresh: true,
        now: NOW,
        resolveExecutable: id => executable(id),
        probeVersion: async (target, timeoutMs) => {
            assert.ok(timeoutMs > 0);
            return target.path.includes('/pi/') ? '0.91.2\n' : '1.1.39\n';
        },
    });
    const pi = detection.runtimes.find(item => item.id === 'pi')!;
    assert.equal(pi.version, '0.91.2');
    assert.equal(pi.status, 'adapter-missing');
    assert.equal(pi.selectable, false);
    assert.equal(pi.diagnostics[0].code, 'RUNTIME_ADAPTER_MISSING');
    // 适配器缺失时不能声称具备能力。
    assert.equal(Object.values(pi.capabilities).some(Boolean), false);
});

test('opencode reports available with declared capabilities and exec metadata', async () => {
    const detection = await detectAgentRuntimes({
        forceRefresh: true,
        now: NOW,
        resolveExecutable: id => executable(id, `/opt/${id}/bin/${id}`),
        probeVersion: async () => '1.1.39\n',
    });
    const opencode = detection.runtimes.find(item => item.id === 'opencode')!;
    assert.equal(opencode.status, 'available');
    assert.equal(opencode.selectable, true);
    assert.equal(opencode.executable?.path, '/opt/opencode/bin/opencode');
    assert.equal(opencode.executable?.source, 'environment');
    assert.equal(opencode.capabilities['tool-policy'], true);
    assert.equal(opencode.capabilities['skill-loading'], true);
    assert.equal(opencode.diagnostics[0].code, 'RUNTIME_READY');
});

test('version below the adapter minimum is incompatible and not selectable', async () => {
    const detection = await detectAgentRuntimes({
        forceRefresh: true,
        now: NOW,
        resolveExecutable: id => executable(id),
        probeVersion: async () => '0.99.9\n',
    });
    const opencode = detection.runtimes.find(item => item.id === 'opencode')!;
    assert.equal(opencode.status, 'incompatible-version');
    assert.equal(opencode.selectable, false);
    assert.equal(opencode.diagnostics[0].code, 'RUNTIME_VERSION_INCOMPATIBLE');
});

test('failed or unparsable version probes never throw and never mark the runtime usable', async () => {
    const detection = await detectAgentRuntimes({
        forceRefresh: true,
        now: NOW,
        resolveExecutable: id => executable(id),
        probeVersion: async () => null,
    });
    for (const runtime of detection.runtimes) {
        assert.equal(runtime.status, 'probe-failed');
        assert.equal(runtime.selectable, false);
        assert.equal(runtime.diagnostics[0].code, 'RUNTIME_PROBE_FAILED');
    }

    const garbage = await detectAgentRuntimes({
        forceRefresh: true,
        now: NOW,
        resolveExecutable: id => executable(id),
        probeVersion: async () => 'not a version',
    });
    assert.equal(garbage.runtimes.every(item => item.status === 'probe-failed'), true);
});

test('a throwing resolver or probe degrades to a diagnostic instead of an exception', async () => {
    const detection = await detectAgentRuntimes({
        forceRefresh: true,
        now: NOW,
        resolveExecutable: () => { throw new Error('boom'); },
        probeVersion: async () => { throw new Error('boom'); },
    });
    assert.equal(detection.runtimes.every(item => item.status === 'not-installed'), true);
});

test('detection results are cached until forceRefresh is requested', async () => {
    let probes = 0;
    const probe = async () => { probes += 1; return '1.1.39\n'; };
    await detectAgentRuntimes({ forceRefresh: true, now: NOW, resolveExecutable: id => executable(id), probeVersion: probe });
    const afterFirst = probes;

    await detectAgentRuntimes({ now: NOW, resolveExecutable: id => executable(id), probeVersion: probe });
    assert.equal(probes, afterFirst);

    await detectAgentRuntimes({ forceRefresh: true, now: NOW, resolveExecutable: id => executable(id), probeVersion: probe });
    assert.ok(probes > afterFirst);
});

test('windows cmd/bat shims are probed through cmd.exe instead of a direct spawn', () => {
    assert.deepEqual(
        buildVersionProbeCommand({ path: '/opt/opencode/bin/opencode', source: 'path' }, 'linux', probeEnv()),
        { command: '/opt/opencode/bin/opencode', args: ['--version'] },
    );
    assert.deepEqual(
        buildVersionProbeCommand({ path: 'C:\\tools\\opencode.exe', source: 'path' }, 'win32', probeEnv()),
        { command: 'C:\\tools\\opencode.exe', args: ['--version'] },
    );

    const cmd = buildVersionProbeCommand(
        { path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.CMD', source: 'path' },
        'win32',
        probeEnv({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }),
    );
    assert.equal(cmd.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(cmd.args, ['/d', '/s', '/c', '""C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.CMD" --version"']);

    const bat = buildVersionProbeCommand(
        { path: 'C:\\tools\\opencode.bat', source: 'bundled' },
        'win32',
        probeEnv(),
    );
    assert.equal(bat.command, 'cmd.exe');
    assert.deepEqual(bat.args, ['/d', '/s', '/c', '""C:\\tools\\opencode.bat" --version"']);
});

test('windows PATH lookup resolves npm .cmd shims via PATHEXT', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-path-'));
    try {
        const shim = path.join(directory, 'opencode.CMD');
        fs.writeFileSync(shim, '@echo off\r\n');
        fs.chmodSync(shim, 0o755);

        assert.deepEqual(
            findOnPath(['opencode'], probeEnv({ PATH: directory, PATHEXT: '.EXE;.CMD;.BAT' }), 'win32'),
            { path: shim, source: 'path' },
        );
        assert.equal(findOnPath(['opencode'], probeEnv({ PATH: directory, PATHEXT: '.EXE;.CMD' }), 'linux'), null);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('runtime version parsing and comparison ignore prefixes and prerelease suffixes', () => {
    assert.equal(parseRuntimeVersion('v1.2.3'), '1.2.3');
    assert.equal(parseRuntimeVersion('1.2.3-beta.4'), '1.2.3');
    assert.equal(parseRuntimeVersion('no digits here'), null);
    assert.equal(parseRuntimeVersion(null), null);

    assert.equal(compareRuntimeVersions('1.2.3', '1.2.3'), 0);
    assert.equal(compareRuntimeVersions('1.2.4', '1.2.3'), 1);
    assert.equal(compareRuntimeVersions('0.82.1', '0.82.1'), 0);
    assert.equal(compareRuntimeVersions('0.82.0', '0.82.1'), -1);
    assert.equal(compareRuntimeVersions('2.0.0', '1.99.99'), 1);
});
