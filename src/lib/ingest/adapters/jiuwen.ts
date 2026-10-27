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
