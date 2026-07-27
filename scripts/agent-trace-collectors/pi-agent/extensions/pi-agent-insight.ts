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
  sessionManager: {
    getSessionId(): string
  }
  [key: string]: unknown
}

export default function piAgentInsightExtension(pi: PiExtensionApi) {
  const collector = createCollector()
  if (!collector) return

  pi.on("session_start", (_event, ctx) => {
    collector.startSession(ctx.sessionManager.getSessionId())
  })

  pi.on("input", (event) => {
    collector.recordInput(event.text)
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
