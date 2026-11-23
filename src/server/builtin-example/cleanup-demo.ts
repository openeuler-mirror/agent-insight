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
import { configuredCoreBackgroundActors } from '@/lib/storage-core/compat';
import { withVerifiedCoreControlActor } from '@/lib/storage-core/control-context';
import { controlRepositoryRequest } from '@/lib/storage-core/control-repository';

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

export async function cleanupBuiltinDemoData(): Promise<BuiltinDemoCleanupResult> {
  const total: BuiltinDemoCleanupResult = { executions: 0, sessions: 0, agents: 0, datasets: 0, skills: 0 };
  const { actors, failures } = await configuredCoreBackgroundActors();
  if (failures.length) throw new Error('Demo cleanup requires verified Core owners');
  for (const actor of actors) {
    const removed = await withVerifiedCoreControlActor(actor, () => controlRepositoryRequest('builtin_demo_cleanup', {}));
    for (const key of Object.keys(total) as Array<keyof BuiltinDemoCleanupResult>) total[key] += removed[key];
  }
  return total;
}
