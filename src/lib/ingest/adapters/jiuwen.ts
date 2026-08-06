import { extractSkillsWithVersionsFromJiuwenSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

/**
 * jiuwen / openJiuwen / JiuwenSwarm (runs on agent-core).
 *
 * Onboarding is "env": jiuwen reports by pointing agent-core's built-in OTLP
 * exporter at our OTEL endpoint — `init_observability(exporter="otlp_http",
 * service_name="jiuwenswarm", endpoint=".../api/ingest/otel/v1/traces")` — no
 * plugin or watcher needed.
 *
 * sessionMergeStrategy = "snapshot-replace": the OTLP exporter pushes spans in
 * batches and our jiuwen ingest re-aggregates the full accumulation each batch,
 * so every saved record is a complete snapshot and must overwrite (not monotonic
 * merge, which would duplicate turns).
 */
export const jiuwenAdapter: FrameworkAdapter = {
  descriptor: {
    id: "jiuwenswarm",
    aliases: ["jiuwen", "openjiuwen"],
    label: "JiuwenSwarm",
    onboard: "env",
    platform: "jiuwenswarm",
  },
  // Jiuwen skill extraction is session-scoped. Subagent execution derivation
  // was not enabled by the previous data-service allowlist, so keep that
  // behavior explicit instead of advertising an unused capability.
  capabilities: { skills: true, skillScope: "session" },
  sessionMergeStrategy: "snapshot-replace",
  // jiuwen invokes a skill via its dedicated `skill_tool` (skill_name arg); detection keys
  // off that tool only (a read_file of SKILL.md is deliberately NOT treated as a skill use).
  extractSkills: extractSkillsWithVersionsFromJiuwenSession,
}
