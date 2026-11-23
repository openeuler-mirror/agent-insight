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

/**
 * Node.js-only instrumentation：所有要 import node:* 模块或调用 prisma/child_process
 * 的启动逻辑都放在这个文件里。
 *
 * 为啥拆出来：Next.js 同时为 nodejs 和 edge runtime 做静态分析，instrumentation.ts
 * 自己里写 `await import('node:fs')` 即使被 `if (NEXT_RUNTIME==='nodejs') return`
 * 包住，Edge 分析器在 parse 时看到 node:* 字样还是会狂打 warning（是 warning 不是
 * error，dev 能跑但每次 HMR 都刷屏）。把 Node-only 块挪到单独文件、由
 * instrumentation.ts 通过 dynamic import 在 runtime gate 之后才加载，分析器在 import
 * 层面就放过了，不再扫这文件内部。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'child_process';
import { getAgentInsightHome } from '@/lib/env';
import { isStorageCoreEnabled } from '@/lib/storage-core/mode';

export async function setupNodeRuntime(): Promise<void> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { loadAgentInsightEnv } = await import('@/lib/env');
  loadAgentInsightEnv();
  const { preflight } = await import('../scripts/storage-core-preflight.cjs');
  await preflight();
  const coreStorage=isStorageCoreEnabled();
  {
    const {startCoreExperimentBackground}=await import('@/lib/storage-core/experiment-background');
    startCoreExperimentBackground();
    const {startCoreAnalyticsBackground}=await import('@/lib/storage-core/analytics');
    startCoreAnalyticsBackground();
    const {startCoreCollectorWorker}=await import('@/lib/storage-core/collector-worker');startCoreCollectorWorker();
    const {startCoreCollectorLogs}=await import('@/lib/storage-core/collector-logs');startCoreCollectorLogs();
  }
  // 注册内置系统 Agent（skill-generator-agent 等）。失败不阻塞启动——惰性注册作为兜底。
  try {
    const { ensureAllSystemAgents } = await import('@/lib/system-agents');
    await ensureAllSystemAgents();
  } catch (err) {
    console.warn(
      '[instrumentation] ensureAllSystemAgents failed (will fall back to lazy register):',
      (err as Error)?.message,
    );
  }

  // 旧版本会为新用户注入内置示例数据；该注入已移除，启动时把旧库里残留的示例
  // Agent / Skill / 数据集 / Trace 按固定标识清掉（精确匹配，重复执行无副作用）。
  try {
    const { cleanupBuiltinDemoData } = await import('@/server/builtin-example/cleanup-demo');
    const removed = await cleanupBuiltinDemoData();
    const total = removed.executions + removed.sessions + removed.agents
      + removed.datasets + removed.skills;
    if (total > 0) {
      console.warn(
        '[instrumentation] 清理内置示例数据:',
        `executions=${removed.executions}`,
        `sessions=${removed.sessions}`,
        `agents=${removed.agents}`,
        `datasets=${removed.datasets}`,
        `skills=${removed.skills}`,
      );
    }
  } catch (err) {
    console.warn('[instrumentation] builtin demo cleanup failed (non-fatal):', (err as Error)?.message);
  }

  // 注册进程退出钩子：dev server / 生产 server 关闭时把 spawn 出去的 opencode 子进程
  // 一并带走，避免孤儿堆积。详见 opencode-manager.registerExitHandlers 的注释。
  try {
    const { registerExitHandlers } = await import(
      '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager'
    );
    registerExitHandlers();
  } catch (err) {
    console.warn(
      '[instrumentation] registerExitHandlers failed:',
      (err as Error)?.message,
    );
  }

  // 回收上一代 server 崩溃(SIGKILL/OOM/jetsam, 跑不了退出钩子)后遗留的 opencode 孤儿进程组。
  // 必须在退出钩子注册之后、本进程开始 spawn opencode 之前跑一次。详见 sweepOrphanedOpencodeProcesses。
  try {
    const { sweepOrphanedOpencodeProcesses } = await import(
      '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager'
    );
    sweepOrphanedOpencodeProcesses();
  } catch (err) {
    console.warn(
      '[instrumentation] sweepOrphanedOpencodeProcesses failed:',
      (err as Error)?.message,
    );
  }




  try {
    const { startInfraPoller } = await import('@/lib/infra/poller');
    startInfraPoller();
  } catch (err) {
    console.warn('[instrumentation] startInfraPoller failed (non-fatal):', (err as Error)?.message);
  }



  setImmediate(() => {
    void import('@/server/trace-datasets/manager')
      .then(({ startTraceDatasetManager }) => startTraceDatasetManager())
      .catch(() => { console.warn('[trace-datasets] generation unavailable'); });
  }).unref();
}
