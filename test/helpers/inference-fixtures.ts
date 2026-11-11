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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

export const temporaryDirectory = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

export const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file: string, data: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function copyProxyRuntime(insightDir: string) {
    const runtime = path.join(insightDir, 'inference-runtime');
    fs.mkdirSync(runtime, { recursive: true });
    for (const file of ['inference_proxy.mjs', 'inference_config.mjs', 'inference_gateway.mjs']) {
        fs.copyFileSync(path.resolve('scripts', file), path.join(runtime, file));
    }
}

export const listen = (server: http.Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
export async function closeServer(server: http.Server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

export function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd(), timeout = 10_000) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => stdout += chunk);
        child.stderr.on('data', chunk => stderr += chunk);
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}
