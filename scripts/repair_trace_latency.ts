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

import { loadAgentInsightEnv } from '../src/lib/env';
import { PrismaClient } from '@prisma/client';
import { repairTraceLatency } from '../src/lib/storage/repair-trace-latency';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

async function main() {
    loadAgentInsightEnv();
    if (process.env.DB_HOST) throw new Error('This repair command supports SQLite deployments only.');
    const { values, positionals } = parseArgs({
        options: { apply: { type: 'boolean', default: false }, framework: { type: 'string', default: 'opencode' }, report: { type: 'string' } },
        allowPositionals: true,
    });
    const framework = values.framework;
    if (framework !== 'opencode' && framework !== 'jiuwenswarm') throw new Error('Supported frameworks: opencode, jiuwenswarm');
    const report = values.report ? fs.openSync(values.report, 'wx', 0o600) : undefined;
    const journal = (event: unknown) => {
        if (report === undefined) return;
        fs.writeFileSync(report, JSON.stringify(event) + '\n');
        fs.fsyncSync(report);
    };
    const client = new PrismaClient();
    try {
        const mode = values.apply ? 'apply' : 'dry-run';
        journal({ type: 'start', mode, framework });
        const result = await repairTraceLatency(client, { apply: values.apply, framework, taskIds: positionals, audit: journal });
        const { changes: _, ...counts } = result;
        journal({ type: 'summary', mode, framework, ...counts });
        console.log(JSON.stringify({ mode, framework, ...counts, report: values.report }));
    } finally {
        if (report !== undefined) fs.closeSync(report);
        await client.$disconnect();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
