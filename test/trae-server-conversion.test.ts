import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ============================================================================
// AC36: 服务端转换回归 —— 插件上传的 trae 载荷经 saveExecutionRecord 正确落库
//
// 验证链路（等价于插件 upload-engine → POST /api/ingest/upload → saveExecutionRecord）：
//   - 主记录字段完整落库（query/tokens/latency/工具与 LLM 计数/skill 提取）
//   - 多 Agent 拆分：interactions 里的 TASK + subagent turn 派生子 Execution 行，
//     parentExecutionId/rootExecutionId/isSubagent 正确（AC33 服务端侧）
//
// 环境处理：本地 ~/.agent-insight/.env 的 AGENT_INSIGHT_DATA_DIR 会让默认库解析
// 到嵌套空库（data/data/witty_insight.db），因此这里显式固定 DATABASE_URL 到
// 与服务一致的真库，并在模块加载前设置（动态 import 保证）。表不存在时自动 skip。
// ============================================================================

// 必须在任何 prisma / data-service 模块加载前固定库地址
process.env.DATABASE_URL = `file:${path.join(os.homedir(), ".agent-insight", "data", "witty_insight.db")}`
delete process.env.AGENT_INSIGHT_DATA_DIR

type SaveResult = { record: any }
type PrismaRaw = {
  execution: {
    findUnique(args: { where: { id: string }; select?: Record<string, boolean> }): Promise<any>
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>
  }
  $queryRawUnsafe(sql: string): Promise<Array<{ name: string }>>
  $disconnect(): Promise<void>
}

async function loadServerModules() {
  const dataService = await import("@/lib/storage/data-service")
  const prismaMod = await import("@/lib/storage/prisma")
  return {
    saveExecutionRecord: dataService.saveExecutionRecord as (data: any) => Promise<SaveResult>,
    prismaRaw: prismaMod.prismaRaw as PrismaRaw,
  }
}

async function assertTableReady(prismaRaw: PrismaRaw): Promise<boolean> {
  try {
    const tables = await prismaRaw.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name='Execution'")
    return tables.length > 0
  } catch {
    return false
  }
}

function makeTraeRecord(uploadId: string, taskId: string, withSubagent: boolean): any {
  const ts = "2026-01-01T00:00:00.000Z"
  const interactions: any[] = [
    { role: "user", content: "写一个 hello world", timestamp: ts, timeInfo: { created: 1767225600000, completed: 1767225600000 }, agent: "solo_agent", agentName: "solo_agent", cwd: "/tmp/project" },
    {
      role: "assistant", content: "完成",
      timestamp: ts, timeInfo: { created: 1767225600000, completed: 1767225610000 },
      agent: "solo_agent", agentName: "solo_agent", model: "deepseek",
      usage: { input: 100, output: 50, total: 150 },
      tool_calls: withSubagent
        ? [{
            id: "task_sub1", type: "function",
            function: { name: "task", arguments: JSON.stringify({ subagent_type: "search", description: "查找资料" }) },
            state: "success", output: JSON.stringify({ subagent_session_id: `${taskId}__search` }),
            timing: { started_at: ts, completed_at: ts },
          }]
        : [
            {
              id: "tool_1", type: "function",
              function: { name: "Write", arguments: JSON.stringify({ file: "hello.ts", content: "console.log(1)" }) },
              state: "success", output: JSON.stringify({ success: true }),
              timing: { started_at: ts, completed_at: ts },
            },
            {
              id: "skill_1", type: "function",
              function: { name: "skill", arguments: JSON.stringify({ name: "code-review", version: null }) },
              state: "success", output: JSON.stringify({}),
              timing: { started_at: ts, completed_at: ts },
            },
          ],
      tool_call_count: 1, tool_call_error_count: 0,
    },
  ]
  if (withSubagent) {
    interactions.push({
      role: "subagent", content: "Executed 1 tool(s): Grep",
      subagent_session_id: `${taskId}__search`, subagent_name: "search",
      agent: "solo_agent", agentName: "solo_agent",
      timestamp: ts, timeInfo: { created: 1767225600000, completed: 1767225605000 },
      tool_calls: [], tool_call_count: 0,
    })
  }
  return {
    upload_id: uploadId, task_id: taskId, framework: "trae",
    query: "写一个 hello world", final_result: "完成",
    tokens: 150, input_tokens: 100, output_tokens: 50,
    latency: 10, timestamp: ts,
    model: "deepseek", agent: "solo_agent", agentName: "solo_agent",
    tool_call_count: 1, llm_call_count: 1, tool_call_error_count: 0,
    skill: "code-review", skills: ["code-review"],
    invokedSkills: [{ name: "code-review", version: null }],
    user: "test",
    interactions,
  }
}

// ============================================================================
// AC36: trae 载荷完整落库
// ============================================================================
test("AC36: trae 载荷经 saveExecutionRecord 完整落库", async (t) => {
  const { saveExecutionRecord, prismaRaw } = await loadServerModules()
  if (!(await assertTableReady(prismaRaw))) {
    t.skip("Execution 表不存在（DATABASE_URL 未指向已迁移的库），跳过服务端转换测试")
    return
  }
  const uploadId = `test-trae-ac36-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  t.after(async () => {
    await prismaRaw.execution.deleteMany({ where: { id: uploadId } })
    await prismaRaw.$disconnect()
  })

  const { record } = await saveExecutionRecord(makeTraeRecord(uploadId, uploadId, false))
  assert.equal(record.task_id, uploadId)

  const row = await prismaRaw.execution.findUnique({
    where: { id: uploadId },
    select: { framework: true, query: true, tokens: true, latency: true, toolCallCount: true, llmCallCount: true, inputTokens: true, outputTokens: true, skills: true, model: true, user: true },
  })
  assert.ok(row, "Execution 行应存在")
  assert.equal(row.framework, "trae", "framework 应为 trae")
  assert.equal(row.query, "写一个 hello world")
  assert.equal(row.tokens, 150)
  assert.equal(row.latency, 10)
  assert.equal(row.toolCallCount, 1)
  assert.equal(row.llmCallCount, 1)
  assert.equal(row.inputTokens, 100)
  assert.equal(row.outputTokens, 50)
  assert.ok(row.skills?.includes("code-review"), "skills 应包含 code-review")
  assert.equal(row.model, "deepseek")
  assert.ok(row.user, "应解析出 user")
})

// ============================================================================
// AC36/AC33: 多 Agent 拆分 —— interactions 里的 subagent 派生独立子行并正确关联
// ============================================================================
test("AC36/AC33: subagent interactions 派生子 Execution 且父子关联正确", async (t) => {
  const { saveExecutionRecord, prismaRaw } = await loadServerModules()
  if (!(await assertTableReady(prismaRaw))) {
    t.skip("Execution 表不存在，跳过服务端转换测试")
    return
  }
  const parentId = `test-trae-ac33-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  t.after(async () => {
    await prismaRaw.execution.deleteMany({ where: { OR: [{ id: parentId }, { parentExecutionId: parentId }] } })
    await prismaRaw.$disconnect()
  })

  await saveExecutionRecord(makeTraeRecord(parentId, parentId, true))

  // 子行 id = `${parentExecId}__sub__${sessionId}`（deriveSubagentExecutions 约定）
  const childId = `${parentId}__sub__${parentId}__search`
  const child = await prismaRaw.execution.findUnique({
    where: { id: childId },
    select: { id: true, parentExecutionId: true, rootExecutionId: true, isSubagent: true, subagentType: true, agentSessionId: true, taskId: true },
  })
  assert.ok(child, `子行 ${childId} 应被派生`)
  assert.equal(child.parentExecutionId, parentId, "parentExecutionId 应指向父记录")
  assert.equal(child.rootExecutionId, parentId, "rootExecutionId 应为根")
  assert.equal(child.isSubagent, true)
  assert.equal(child.subagentType, "search")
  assert.equal(child.agentSessionId, `${parentId}__search`)
})
