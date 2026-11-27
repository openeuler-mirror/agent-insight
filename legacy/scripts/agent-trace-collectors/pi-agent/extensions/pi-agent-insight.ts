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

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { createCollector } = require("../lib/pi-trace-core.cjs")

type PiExtensionApi = {
  on(event: string, handler: (event: PiExtensionEvent, context: PiExtensionContext) => unknown): void
}

type PiExtensionEvent = {
  text?: string
  model?: unknown
  message?: unknown
  messages?: unknown[]
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  [key: string]: unknown
}

type PiExtensionContext = {
  cwd?: string
  sessionManager: {
    getSessionId(): string
  }
  [key: string]: unknown
}

export default function piAgentInsightExtension(pi: PiExtensionApi) {
  const collector = createCollector()
  if (!collector) return

  pi.on("session_start", (_event, ctx) => {
    collector.startSession(ctx.sessionManager.getSessionId(), ctx)
  })

  pi.on("input", (event) => {
    collector.recordInput(event.text, event.source)
  })

  pi.on("context", (event, ctx) => {
    collector.recordContext(event.messages, ctx)
  })

  pi.on("before_agent_start", (event, ctx) => {
    collector.beginAgent(event, ctx)
  })

  pi.on("model_select", (event) => {
    collector.setModel(event.model)
  })

  pi.on("message_end", (event) => {
    collector.recordMessage(event.message)
  })

  pi.on("tool_execution_start", (event) => {
    collector.beginTool(event)
  })

  pi.on("tool_execution_end", (event) => {
    collector.endTool(event)
  })

  pi.on("agent_end", (event) => {
    collector.recordAgentEnd(event)
  })

  pi.on("agent_settled", async () => {
    await collector.settleAgent()
  })

  pi.on("session_shutdown", async () => {
    await collector.shutdown()
  })
}
