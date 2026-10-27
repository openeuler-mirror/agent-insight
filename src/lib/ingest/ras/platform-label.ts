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

/** Display labels for Agent RAS / observe platform (framework) codes. */
export function getPlatformLabel(platform?: string | null): string {
  const value = String(platform || "").trim();
  if (!value) return "—";
  switch (value.toLowerCase()) {
    case "langfuse-langgraph":
      return "Langfuse-Langgraph";
    case "opencode":
      return "OpenCode";
    case "openjiuwen":
    case "jiuwen":
      return "openJiuwen";
    case "claude":
    case "claudecode":
      return "Claude Code";
    case "hermes":
      return "Hermes";
    case "openclaw":
      return "OpenClaw";
    case "xiaoo":
      return "xiaoO";
    case "qwenpaw":
      return "QwenPaw";
    case "workbuddy":
      return "WorkBuddy";
    default:
      return value;
  }
}

/** Prefer RAS event platform, then execution framework. */
export function resolveTracePlatform(opts: {
  eventPlatform?: string | null;
  eventFramework?: string | null;
  executionFramework?: string | null;
}): string | null {
  const raw =
    String(opts.eventPlatform || "").trim()
    || String(opts.eventFramework || "").trim()
    || String(opts.executionFramework || "").trim();
  return raw || null;
}
