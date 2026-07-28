import { traeAdapter } from "./trae"
import { actrailAdapter } from "./actrail"
import { claudeAdapter } from "./claude"
import { codeagentAdapter } from "./codeagent"
import { codexAdapter } from "./codex"
import { hermesAdapter } from "./hermes"
import { jiuwenAdapter } from "./jiuwen"
import { langfuseLangGraphAdapter } from "./langfuse-langgraph"
import { llamaIndexAdapter } from "./llamaindex"
import { openclawAdapter } from "./openclaw"
import { opencodeAdapter } from "./opencode"
import { piAgentAdapter } from "./pi-agent"
import { qoderAdapter } from "./qoder"
import type { FrameworkAdapter, FrameworkDescriptor } from "./types"

const adapters = [opencodeAdapter, claudeAdapter, codeagentAdapter, openclawAdapter, hermesAdapter, codexAdapter, jiuwenAdapter, langfuseLangGraphAdapter, llamaIndexAdapter, qoderAdapter, traeAdapter, actrailAdapter, piAgentAdapter] as const

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
