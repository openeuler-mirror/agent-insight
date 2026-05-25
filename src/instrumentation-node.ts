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
import os from 'node:os';
import { spawn } from 'node:child_process';

export async function setupNodeRuntime(): Promise<void> {
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

  // 启动时跑一次 uploader：把上一轮 dev server 留下的 spool 积压清掉，避免那些 trace
  // 一直没归宿。常态下 plugin 的 kickUploader 在每次 opencode event 都会触发一次
  // 一次性 uploader 进程，所以这里只补"启动空窗期"。
  try {
    const uploader = path.join(os.homedir(), '.skill-insight', 'opencode_uploader_client.js');
    if (fs.existsSync(uploader)) {
      const child = spawn(process.execPath, [uploader], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, SKILL_INSIGHT_UPLOADER_FORCE: '1' },
      });
      child.unref();
    }
  } catch (err) {
    console.warn(
      '[instrumentation] backlog uploader kick failed:',
      (err as Error)?.message,
    );
  }
}
