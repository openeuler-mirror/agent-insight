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

import { normalizeClaudeCodeInteractionsForStorage } from "@/lib/shared/interaction-content"
import { extractSkillsWithVersionsFromClaudeSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const claudeAdapter: FrameworkAdapter = {
  descriptor: {
    id: "claude",
    aliases: ["claudecode"],
    label: "Claude Code",
    onboard: "watcher",
    platform: "claude",
  },
  capabilities: {
    skills: true,
    skillScope: "session",
    subagentTree: true,
  },
  normalizeForStorage: normalizeClaudeCodeInteractionsForStorage,
  // 聚合器每次都从 spool 全量事件重建完整快照(readClaudeOtelEventsForSession 扫全部天),
  // incoming 永远是"当前最全的解释" —— 和 codeagent/jiuwen 同理,应整条覆盖。
  // 走默认 monotonic 有个致命问题:客户端补传(subagent_map)会把先前平铺在 root 的
  // 子 agent 轮次**重解释**为 role=subagent,monotonic 按 key 合并认不出这是同一条消息,
  // 新旧两种解释共存,task 调用双份、建树长出重复子节点。
  // 退化快照(如 spool 按保留期归档后事件变少)由 data-service 的 snapshot-replace
  // 缩水护栏兜住:incoming 更小则保留库里现有记录。
  sessionMergeStrategy: 'snapshot-replace',
  extractSkills: extractSkillsWithVersionsFromClaudeSession,
}
