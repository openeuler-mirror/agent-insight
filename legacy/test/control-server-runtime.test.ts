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
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import os from 'node:os';
import { createRequire } from 'node:module';

async function boot(env: Record<string, string> = {}, standalone?: string, realNext = false) {
    const observed: { cwd?: string; dispatchAtNext?: string; listeners: number[]; errors: unknown[] } = { listeners: [], errors: [] };
    const processEnv: Record<string, string> = { PORT: '32131', ...env };
    const source = fs.readFileSync(path.resolve('scripts/control-server.js'), 'utf8');
    const server = () => ({
        on() {},
        listen(port: number, _host: string, ready: () => void) { observed.listeners.push(port); ready(); },
        close() {},
    });
    const nextApp = () => {
        observed.dispatchAtNext = processEnv.AGENT_INSIGHT_RAS_DISPATCH_PORT;
        return { getRequestHandler: () => () => {}, prepare: async () => {} };
    };
    vm.runInNewContext(source, {
        __dirname: '/package/scripts',
        process: {
            env: processEnv,
            argv: ['node', '/package/scripts/control-server.js', ...(standalone ? [standalone] : [])],
            chdir(value: string) { observed.cwd = value; },
            on() {},
            exit(code: number) { observed.errors.push(code); },
        },
        console: { log() {}, error(...args: unknown[]) { observed.errors.push(args); } },
        require(name: string) {
            if (name === 'node:module') return { createRequire: (file: string) => realNext ? createRequire(file) : () => nextApp };
            if (name === 'http') return { createServer: server };
            if (name === 'path') return path;
            if (name === 'fs') return { existsSync: () => true };
            if (name === './ws-endpoint') return { upgradeToWebSocket() {} };
            if (name.endsWith('/required-server-files.json')) return { config: {} };
            if (name.endsWith('/node_modules/next')) return realNext ? createRequire(import.meta.url)(name) : nextApp;
            throw new Error(`Unexpected dependency: ${name}`);
        },
        setTimeout: () => ({ unref() {} }),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(observed.errors, []);
    return observed;
}

test('control gateway publishes its default dispatch port before loading Next routes', async () => {
    const observed = await boot();
    assert.equal(observed.dispatchAtNext, '32132');
    assert.deepEqual(observed.listeners, [32132, 32131]);
});

test('control gateway preserves an explicit dispatch port', async () => {
    const observed = await boot({ AGENT_INSIGHT_RAS_DISPATCH_PORT: '32141' });
    assert.equal(observed.dispatchAtNext, '32141');
    assert.deepEqual(observed.listeners, [32141, 32131]);
});

test('control gateway accepts the nested standalone directory produced by source builds', async () => {
    const observed = await boot({}, '/build/.next/standalone/project');
    assert.equal(observed.cwd, '/build/.next/standalone/project');
});


test('nested source standalone resolves its Next dependency from the parent tracing root', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-standalone-layout-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const standalone = path.join(root, 'standalone');
    const sourceRoot = path.join(standalone, 'source');
    fs.mkdirSync(path.join(standalone, 'node_modules/next'), { recursive: true });
    fs.mkdirSync(sourceRoot);
    fs.writeFileSync(path.join(standalone, 'node_modules/next/index.js'), 'module.exports = () => ({ getRequestHandler: () => () => {}, prepare: async () => {} });');
    fs.writeFileSync(path.join(sourceRoot, 'server.js'), 'require("next");');
    assert.doesNotThrow(() => createRequire(path.join(sourceRoot, 'server.js'))('next'));
    const observed = await boot({}, sourceRoot, true);
    assert.equal(observed.cwd, sourceRoot);
    assert.deepEqual(observed.listeners, [32132, 32131]);
});
