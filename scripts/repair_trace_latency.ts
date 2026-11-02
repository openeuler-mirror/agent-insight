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

async function main() {
    loadAgentInsightEnv();
    if (process.env.DB_HOST) throw new Error('This repair command supports SQLite deployments only.');
    const args = process.argv.slice(2);
    if (args.some(arg => arg.startsWith('-') && arg !== '--apply')) {
        throw new Error('Usage: node --import tsx scripts/repair_trace_latency.ts [--apply] [taskId ...]');
    }
    const client = new PrismaClient();
    try {
        const apply = args.includes('--apply');
        const result = await repairTraceLatency(client, { apply, taskIds: args.filter(arg => arg !== '--apply') });
        console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }));
    } finally {
        await client.$disconnect();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
