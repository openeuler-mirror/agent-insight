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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const entrypoint = fs.readFileSync(path.join(process.cwd(), 'scripts/docker-entrypoint.sh'), 'utf8');
const envExample = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');

function resolveLogs(options: { envFile?: string; template?: string; processValue?: string }) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-docker-logs-'));
    const runtimeHome = path.join(fixture, 'mounted home');
    const packageRoot = path.join(fixture, 'package');
    try {
        fs.mkdirSync(runtimeHome);
        fs.mkdirSync(packageRoot);
        if (options.envFile !== undefined) fs.writeFileSync(path.join(runtimeHome, '.env'), options.envFile);
        if (options.template !== undefined) fs.writeFileSync(path.join(packageRoot, '.env.example'), options.template);
        const boundary = 'if [ -x "$OPENCODE_BIN" ]; then';
        assert.ok(entrypoint.includes(boundary), 'Run the real configuration prefix before launching dependencies');
        const prefix = entrypoint.slice(0, entrypoint.indexOf(boundary))
            .replace('PACKAGE_ROOT="/app/node_modules/agent-insight"', `PACKAGE_ROOT="${packageRoot}"`);
        const env: NodeJS.ProcessEnv = {
            NODE_ENV: 'test',
            HOME: fixture,
            PATH: process.env.PATH,
            AGENT_INSIGHT_HOME: runtimeHome,
        };
        if (options.processValue !== undefined) env.AGENT_INSIGHT_LOG_DIR = options.processValue;
        const logDir = execFileSync('/bin/sh', ['-c', `${prefix}\n/bin/sh -c 'printf "%s" "\${AGENT_INSIGHT_LOG_DIR:-}"'`], {
            env,
            encoding: 'utf8',
        });
        const envFile = fs.existsSync(path.join(runtimeHome, '.env'))
            ? fs.readFileSync(path.join(runtimeHome, '.env'), 'utf8')
            : undefined;
        return { logDir, runtimeHome, envFile };
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
}

test('Docker defaults logs to the mounted runtime home without a configuration file', () => {
    const result = resolveLogs({});
    assert.equal(result.logDir, path.join(result.runtimeHome, 'logs'));
});

test('Docker resolves the copied template log default under the mounted runtime home', () => {
    const result = resolveLogs({ template: envExample });
    assert.equal(result.logDir, path.join(result.runtimeHome, 'logs'));
    assert.equal(result.envFile, envExample);
});

test('Docker resolves the old template default without rewriting an existing configuration', () => {
    const envFile = 'AGENT_INSIGHT_LOG_DIR=/var/log/agent-insight\n';
    const result = resolveLogs({ envFile });
    assert.equal(result.logDir, path.join(result.runtimeHome, 'logs'));
    assert.equal(result.envFile, envFile);
});

test('Docker preserves a custom log path configured in the runtime .env', () => {
    assert.equal(resolveLogs({ envFile: 'AGENT_INSIGHT_LOG_DIR="/custom mounted/logs"\n' }).logDir, '/custom mounted/logs');
});

test('Docker process log configuration takes precedence over the runtime .env', () => {
    assert.equal(resolveLogs({
        envFile: 'AGENT_INSIGHT_LOG_DIR=/custom/from-file\n',
        processValue: '/custom/from-container',
    }).logDir, '/custom/from-container');
});

test('Docker preserves an explicitly requested legacy log path in the process environment', () => {
    assert.equal(resolveLogs({
        template: envExample,
        processValue: '/var/log/agent-insight',
    }).logDir, '/var/log/agent-insight');
});

test('Docker treats an explicitly empty process log setting as the container default', () => {
    const result = resolveLogs({ envFile: 'AGENT_INSIGHT_LOG_DIR=/custom/from-file\n', processValue: '' });
    assert.equal(result.logDir, path.join(result.runtimeHome, 'logs'));
});
