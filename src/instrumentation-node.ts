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

  // 确保内置「messages 日志分析」示例日志存在于平台数据根。内置 case 的 query 指向
  // ~/.agent-insight/example/messages（执行时展开成绝对路径），换台干净服务器/重装后那个
  // 路径可能没文件 → agent 一读就 "No such file" 直接结束。这里"不在才补"一份（存在即跳过，
  // 绝不覆盖）。详见 ensure-example-file.ts。
  try {
    const { ensureExampleMessagesFile } = await import('@/server/builtin-example/ensure-example-file');
    if (ensureExampleMessagesFile() === 'copied') {
      console.warn('[instrumentation] 补齐内置示例日志 → ~/.agent-insight/example/messages');
    }
  } catch (err) {
    console.warn('[instrumentation] ensure example messages failed (non-fatal):', (err as Error)?.message);
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

  // 回收"僵尸评测行":进程崩溃/重启后,后台评测 promise 已死,但 DB 里仍是 running/pending →
  // 前端永远显示「评测中」、运行计数不归零(连带 run 无法删除),且内存里已无 controller 故无从终止。
  // 启动时一次性把它们标失败(重启 = 没有任何评测真的在跑),跟 opencode 孤儿回收同理。
  try {
    const { prismaRaw } = await import('@/lib/storage/prisma');
    const t = await prismaRaw.trajectoryEvalResult.updateMany({
      where: { status: { in: ['running', 'pending'] } },
      data: { status: 'failed', errorMessage: '服务重启，评测中断（stale）' },
    });
    let triggerReaped = 0;
    try {
      const r = await prismaRaw.skillTriggerEvalRun.updateMany({
        where: { status: 'running' },
        data: { status: 'failed', errorMessage: '服务重启，评测中断（stale）' },
      });
      triggerReaped = r.count;
    } catch { /* 该表可能尚未建/无 errorMessage 列时忽略 */ }
    if (t.count > 0 || triggerReaped > 0) {
      console.warn(`[instrumentation] 回收僵尸评测行: trajectory ${t.count} 条 + trigger ${triggerReaped} 条 → failed`);
    }
  } catch (err) {
    console.warn('[instrumentation] stale eval reap failed:', (err as Error)?.message);
  }

  // 回收灰度(A/B)任务里的崩溃残骸运行:它们存在 GrayscaleTask.caseStatesJson 里(不是 TrajectoryEvalResult),
  // 上面的评测行回收覆盖不到。不清的话,用户重跑同一灰度任务时,上一轮崩溃的旧 run 会被惰性标成
  // 「服务重启中断」、混进新一轮里像新跑报错。开机清掉,保证重跑干净、状态一致。
  try {
    const { reapStaleGrayscaleRunsAtStartup } = await import('@/app/api/debug/grayscale-tasks/[taskId]/route');
    const n = await reapStaleGrayscaleRunsAtStartup();
    if (n > 0) console.warn(`[instrumentation] 回收灰度崩溃残骸: ${n} 个任务的非终态运行 → failed`);
  } catch (err) {
    console.warn('[instrumentation] stale grayscale reap failed:', (err as Error)?.message);
  }

  // 启动时跑一次 uploader：把上一轮 dev server 留下的 spool 积压清掉，避免那些 trace
  // 一直没归宿。常态下 plugin 的 kickUploader 在每次 opencode event 都会触发一次
  // 一次性 uploader 进程，所以这里只补"启动空窗期"。
  try {
    const uploader = path.join(
      os.homedir(),
      fs.existsSync(path.join(os.homedir(), '.agent-insight')) ? '.agent-insight' : '.skill-insight',
      'opencode_uploader_client.js',
    );
    // 用仓库最新版刷新部署副本: 旧副本可能读 legacy 的 SKILL_INSIGHT_API_KEY → 拿错 key 上传 401、
    // spool 永远清不掉、uploader 啃积压跑很久 → 叠加堆爆(实测 75 个进程吃爆内存)。每次启动同步一次。
    try {
      const repoUploader = path.join(process.cwd(), 'scripts', 'opencode_uploader_client.js');
      if (fs.existsSync(repoUploader) && path.resolve(repoUploader) !== path.resolve(uploader)) {
        fs.copyFileSync(repoUploader, uploader);
      }
    } catch (e) {
      console.warn('[instrumentation] refresh uploader client failed:', (e as Error)?.message);
    }
    if (fs.existsSync(uploader)) {
      const child = spawn(process.execPath, [uploader], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, AGENT_INSIGHT_UPLOADER_FORCE: '1' },
      });
      child.unref();
    }
  } catch (err) {
    console.warn(
      '[instrumentation] backlog uploader kick failed:',
      (err as Error)?.message,
    );
  }

  try {
    const { startOtelSpoolConsumer } = await import('@/lib/ingest/otel-consumer/consumer');
    startOtelSpoolConsumer();
  } catch (err) {
    console.warn(
      '[instrumentation] otel spool consumer start failed:',
      (err as Error)?.message,
    );
  }

  try {
    const { startInfraPoller } = await import('@/lib/infra/poller');
    startInfraPoller();
  } catch (err) {
    console.warn('[instrumentation] startInfraPoller failed (non-fatal):', (err as Error)?.message);
  }
}
