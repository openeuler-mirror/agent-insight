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
 * 清理旧版本为新用户注入的内置示例数据。
 *
 * 内置示例注入已移除，但旧数据库里仍可能留有当时写入的 Agent / Skill / 数据集 /
 * Trace。启动时按注入时写死的固定标识删除，全部条件都是精确匹配，不碰用户自己
 * 创建的数据；重复执行时为 no-op。
 */
import fs from 'node:fs';
import { prisma } from '@/lib/storage/prisma';
import { getSkillVersionStorageDir } from '@/lib/env';

export const DEMO_AGENT_NAME = 'messages-log-analyzer';
export const DEMO_AGENT_DESCRIPTION =
  '内置示例：messages 日志安全分析 Agent（新用户注册时自动注入的演示 trace）';
export const DEMO_DATASET_NAME = 'messages 日志分析（内置示例）';
export const DEMO_SKILL_NAME = 'linux-messages-auth-triage-demo';
export const DEMO_SKILL_DESCRIPTION =
  '内置示例 Skill：离线分析 Linux messages 日志中的认证失败、暴力破解、用户枚举与登录异常事件。';
/** seed 时为 Session / Execution 生成的 taskId 前缀。 */
export const DEMO_TASK_ID_PREFIX = 'builtin_msg_';

export interface BuiltinDemoCleanupResult {
  executions: number;
  sessions: number;
  agents: number;
  datasets: number;
  skills: number;
}

type CountedKey = keyof BuiltinDemoCleanupResult;

interface CleanupOp {
  /** 计数归属；null 表示仅供清理外键/从表，不对外汇报。 */
  key: CountedKey | null;
  run: () => Promise<unknown>;
}

export async function cleanupBuiltinDemoData(): Promise<BuiltinDemoCleanupResult> {
  // OpenGauss (DB_HOST) 走精简适配器，旧版注入流程在该模式下本就写不进去；跳过以免
  // 每次启动都因适配器未实现 deleteMany 而报错。
  if (process.env.DB_HOST) {
    return { executions: 0, sessions: 0, agents: 0, datasets: 0, skills: 0 };
  }

  const taskWhere = { taskId: { startsWith: DEMO_TASK_ID_PREFIX } };
  const demoExecutionIds = (
    await prisma.execution.findMany({ where: taskWhere, select: { id: true } })
  ).map((row: { id: string }) => row.id);

  // Skill 的匹配条件与注入时写入的一致（name + description + author + isUploaded），
  // 避免误删用户自建的同名 Skill；落盘目录需要先查出版本号。
  const demoSkillWhere = {
    name: DEMO_SKILL_NAME,
    description: DEMO_SKILL_DESCRIPTION,
    author: null,
    isUploaded: false,
  };
  const demoSkills = await prisma.skill.findMany({
    where: demoSkillWhere,
    select: { id: true, versions: { select: { version: true } } },
  });

  const evaluationIds = demoExecutionIds.length
    ? (
        await prisma.evaluation.findMany({
          where: { executionId: { in: demoExecutionIds } },
          select: { id: true },
        })
      ).map((row: { id: string }) => row.id)
    : [];
  const diagnosisSessionIds = demoExecutionIds.length
    ? (
        await prisma.faultDiagnosisSession.findMany({
          where: { executionId: { in: demoExecutionIds } },
          select: { id: true },
        })
      ).map((row: { id: string }) => row.id)
    : [];

  const ops: CleanupOp[] = [];
  if (evaluationIds.length > 0) {
    ops.push({ key: null, run: () => prisma.skillIssue.deleteMany({ where: { evaluationId: { in: evaluationIds } } }) });
    ops.push({ key: null, run: () => prisma.evaluation.deleteMany({ where: { id: { in: evaluationIds } } }) });
  }
  if (diagnosisSessionIds.length > 0) {
    ops.push({ key: null, run: () => prisma.faultDiagnosisMessage.deleteMany({ where: { sessionId: { in: diagnosisSessionIds } } }) });
    ops.push({ key: null, run: () => prisma.faultDiagnosisSession.deleteMany({ where: { id: { in: diagnosisSessionIds } } }) });
  }
  if (demoExecutionIds.length > 0) {
    // Execution 的从表不全是外键约束，只能按 executionId/taskId 显式清理，否则会留下
    // 指向已删 Trace 的孤儿评测/诊断记录（对齐 /api/agents/[id] 的删除逻辑）。
    ops.push({ key: null, run: () => prisma.executionMatch.deleteMany({ where: { executionId: { in: demoExecutionIds } } }) });
    ops.push({
      key: null,
      run: () =>
        prisma.trajectoryEvalResult.deleteMany({
          where: { OR: [{ executionId: { in: demoExecutionIds } }, taskWhere] },
        }),
    });
    ops.push({ key: null, run: () => prisma.agentDebugReport.deleteMany({ where: { executionId: { in: demoExecutionIds } } }) });
    ops.push({ key: null, run: () => prisma.agentDebugSkillsAnalysis.deleteMany({ where: { executionId: { in: demoExecutionIds } } }) });
    ops.push({ key: null, run: () => prisma.diagnosisRun.deleteMany({ where: { executionId: { in: demoExecutionIds } } }) });
  }
  ops.push({ key: 'sessions', run: () => prisma.session.deleteMany({ where: taskWhere }) });
  ops.push({ key: 'executions', run: () => prisma.execution.deleteMany({ where: taskWhere }) });
  ops.push({
    key: 'agents',
    run: () =>
      prisma.registeredAgent.deleteMany({
        where: { name: DEMO_AGENT_NAME, description: DEMO_AGENT_DESCRIPTION },
      }),
  });
  ops.push({ key: 'datasets', run: () => prisma.agentEvalDataset.deleteMany({ where: { name: DEMO_DATASET_NAME } }) });
  ops.push({ key: 'skills', run: () => prisma.skill.deleteMany({ where: demoSkillWhere }) });

  // 整体放在一个事务里：任一表失败都不留下半清理状态。
  const results = await prisma.$transaction(ops.map((op) => op.run()));
  const removed: BuiltinDemoCleanupResult = {
    executions: 0,
    sessions: 0,
    agents: 0,
    datasets: 0,
    skills: 0,
  };
  ops.forEach((op, index) => {
    if (!op.key) return;
    removed[op.key] += Number((results[index] as { count?: number })?.count ?? 0);
  });

  // DB 行已提交删除，再清掉落盘资源；目录消失或只读不影响清理结果。
  for (const skill of demoSkills) {
    for (const version of skill.versions) {
      try {
        fs.rmSync(getSkillVersionStorageDir(skill.id, version.version), {
          recursive: true,
          force: true,
        });
      } catch {
        // 文件可能已被用户删除或目录只读；不影响数据库清理。
      }
    }
  }

  return removed;
}
