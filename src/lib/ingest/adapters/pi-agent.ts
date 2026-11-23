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

import { extractSkillsWithVersionsFromOpencodeSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const piAgentAdapter: FrameworkAdapter = {
  descriptor: {
    id: "pi-agent",
    label: "Pi Agent",
    onboard: "plugin",
    platform: "pi",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
    allowSnapshotShrink: true,
    skillScope: "agent-tree",
  },
  // Pi 的 OTLP consumer 每次都会从同一 task 的完整 spool 重聚合。保存时必须以完整
  // 快照替换旧结果，才能清除 Generic adapter 留下的 agent.pi/subagent 假 Tool。
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
}
