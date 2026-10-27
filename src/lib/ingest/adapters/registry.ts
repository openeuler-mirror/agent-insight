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

import { traeAdapter } from "./trae"
import { actrailAdapter } from "./actrail"
import { claudeAdapter } from "./claude"
import { codeagentAdapter } from "./codeagent"
import { codexAdapter } from "./codex"
import { deepSeekHarnessAdapter } from './deepseek-harness'
import { hermesAdapter } from "./hermes"
import { jiuwenAdapter } from "./jiuwen"
import { langfuseLangGraphAdapter } from "./langfuse-langgraph"
import { llamaIndexAdapter } from "./llamaindex"
import { openclawAdapter } from "./openclaw"
import { opencodeAdapter } from "./opencode"
import { piAgentAdapter } from "./pi-agent"
import { qoderAdapter } from "./qoder"
import { qwenpawAdapter } from "./qwenpaw"
import { qwencodeAdapter } from "./qwencode"
import { mctsXgovernorAdapter } from './mcts-xgovernor'
import type { FrameworkAdapter, FrameworkDescriptor } from "./types"

const adapters = [
  opencodeAdapter,
  claudeAdapter,
  codeagentAdapter,
  qwencodeAdapter,
  openclawAdapter,
  hermesAdapter,
  codexAdapter,
  deepSeekHarnessAdapter,
  jiuwenAdapter,
  langfuseLangGraphAdapter,
  llamaIndexAdapter,
  qwenpawAdapter,
  qoderAdapter,
  traeAdapter,
  actrailAdapter,
  piAgentAdapter,
  mctsXgovernorAdapter,
] as const

const fallbackAdapter: FrameworkAdapter = {
  descriptor: {
    id: "unknown",
    label: "Unknown",
    onboard: "env",
  },
}

const adapterByKey = new Map<string, FrameworkAdapter>()

for (const adapter of adapters) {
  adapterByKey.set(adapter.descriptor.id.toLowerCase(), adapter)
  for (const alias of adapter.descriptor.aliases ?? []) {
    adapterByKey.set(alias.toLowerCase(), adapter)
  }
}

function normalizeFrameworkKey(framework: string | null | undefined): string {
  return String(framework ?? "").trim().toLowerCase()
}

export function getAdapter(framework: string | null | undefined): FrameworkAdapter {
  return adapterByKey.get(normalizeFrameworkKey(framework)) ?? fallbackAdapter
}

export function resolveFrameworkId(framework: string | null | undefined): string {
  const key = normalizeFrameworkKey(framework)
  return adapterByKey.get(key)?.descriptor.id ?? key
}

export function listFrameworks(): FrameworkDescriptor[] {
  return adapters.map((adapter) => adapter.descriptor)
}
