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

import type { InvokedSkill } from "@/lib/shared/interaction-utils"

export type CanonicalInteraction = any
export type SessionMergeStrategy = "monotonic" | "snapshot-replace"

export interface FrameworkDescriptor {
  id: string
  aliases?: string[]
  label: string
  onboard: "plugin" | "env" | "watcher"
  platform?: string
}

export interface FrameworkCapabilities {
  skills?: boolean
  subagentTree?: boolean
  skillScope?: "session" | "agent-tree"
  allowSnapshotShrink?: boolean
}

export interface FrameworkAdapter {
  readonly descriptor: FrameworkDescriptor
  readonly capabilities?: FrameworkCapabilities
  readonly sessionMergeStrategy?: SessionMergeStrategy
  normalizeForStorage?(interactions: CanonicalInteraction[]): CanonicalInteraction[]
  extractSkills?(normalized: CanonicalInteraction[]): InvokedSkill[]
  isPlaceholderQuery?(query: string, framework: string): boolean
}
