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
/** seed 时为 Session / Execution 生成的 taskId 前缀。 */
export const DEMO_TASK_ID_PREFIX = 'builtin_msg_';

export interface BuiltinDemoCleanupResult {
  executions: number;
  sessions: number;
  agents: number;
  datasets: number;
  skills: number;
}

export async function cleanupBuiltinDemoData(): Promise<BuiltinDemoCleanupResult> {
  // OpenGauss (DB_HOST) 走精简适配器，旧版注入流程在该模式下本就写不进去；跳过以免
  // 每次启动都因适配器未实现 deleteMany 而报错。
  if (process.env.DB_HOST) {
    return { executions: 0, sessions: 0, agents: 0, datasets: 0, skills: 0 };
  }

  const executions = await prisma.execution.deleteMany({
    where: { taskId: { startsWith: DEMO_TASK_ID_PREFIX } },
  });
  const sessions = await prisma.session.deleteMany({
    where: { taskId: { startsWith: DEMO_TASK_ID_PREFIX } },
  });
  const agents = await prisma.registeredAgent.deleteMany({
    where: { name: DEMO_AGENT_NAME, description: DEMO_AGENT_DESCRIPTION },
  });
  const datasets = await prisma.agentEvalDataset.deleteMany({
    where: { name: DEMO_DATASET_NAME },
  });

  // Skill 删除会级联 SkillVersion / Evaluation / SkillIssue；先把落盘资源清掉。
  const skills = await prisma.skill.findMany({
    where: { name: DEMO_SKILL_NAME },
    select: { id: true, versions: { select: { version: true } } },
  });
  let deletedSkills = 0;
  for (const skill of skills) {
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
    await prisma.skill.delete({ where: { id: skill.id } });
    deletedSkills += 1;
  }

  return {
    executions: executions.count,
    sessions: sessions.count,
    agents: agents.count,
    datasets: datasets.count,
    skills: deletedSkills,
  };
}
