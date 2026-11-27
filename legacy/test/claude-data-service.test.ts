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

import assert from "node:assert/strict"
import test from "node:test"

import { isolateTestDatabase } from "./helpers/isolated-test-db"
isolateTestDatabase("claude-data-service")
import {
  saveExecutionRecord,
  shouldRefreshStoredQueryFromInteractions,
} from "@/lib/storage/data-service"
import { prismaRaw } from "@/lib/storage/prisma"

const UUID = "2a1b9675-13d5-40b7-b3f1-0590e88d0109"

test("Claude query: 仅刷新 claudecode 的 UUID 占位标题", () => {
  assert.equal(shouldRefreshStoredQueryFromInteractions(`Claude Code Session ${UUID}`, "claudecode"), true)
  assert.equal(shouldRefreshStoredQueryFromInteractions("Claude Code Session troubleshooting", "claudecode"), false)
  assert.equal(shouldRefreshStoredQueryFromInteractions(`Claude Code Session ${UUID}`, "claude"), false)
  assert.equal(shouldRefreshStoredQueryFromInteractions(`Claude Code Session ${UUID}`, "opencode"), false)
  assert.equal(shouldRefreshStoredQueryFromInteractions("用户真实输入", "claudecode"), false)
})

test("claudecode 子 Agent: 保存 root 时派生两个 child Execution 并刷新 query", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const executionId = `test-claude-root-${suffix}`
  const taskId = `10000000-0000-4000-8000-${suffix.replace(/\D/g, "").padEnd(12, "0").slice(0, 12)}`
  const child1 = `${taskId}:call_child_1`
  const child2 = `${taskId}:call_child_2`
  const interactions = [
    { role: "user", content: "真实用户输入", timestamp: "2026-08-02T10:00:00.000Z", agent: "Claude Code" },
    {
      role: "assistant",
      content: "分派两个任务",
      timestamp: "2026-08-02T10:00:01.000Z",
      agent: "Claude Code",
      tool_calls: [
        {
          id: "call_child_1",
          name: "task",
          function: { name: "task", arguments: JSON.stringify({ subagent_type: "general-purpose", prompt: "计算 3+3" }) },
        },
        {
          id: "call_child_2",
          name: "task",
          function: { name: "task", arguments: JSON.stringify({ subagent_type: "general-purpose", prompt: "计算 4×5" }) },
        },
      ],
    },
    {
      role: "subagent",
      content: "6",
      timestamp: "2026-08-02T10:00:02.000Z",
      agent: "general-purpose",
      subagent_name: "general-purpose",
      subagent_session_id: child1,
    },
    {
      role: "subagent",
      content: "20",
      timestamp: "2026-08-02T10:00:03.000Z",
      agent: "general-purpose",
      subagent_name: "general-purpose",
      subagent_session_id: child2,
    },
    { role: "assistant", content: "结果是 6 和 20", timestamp: "2026-08-02T10:00:04.000Z", agent: "Claude Code" },
  ]

  try {
    await saveExecutionRecord({
      upload_id: executionId,
      task_id: taskId,
      query: `Claude Code Session ${taskId}`,
      framework: "claudecode",
      final_result: "结果是 6 和 20",
      interactions,
      user: "test",
      skip_evaluation: true,
      skip_internal_judgment: true,
    })

    const root = await prismaRaw.execution.findUnique({
      where: { id: executionId },
      select: { query: true, isSubagent: true },
    })
    assert.equal(root?.query, "真实用户输入")
    assert.equal(root?.isSubagent, false)

    const children = await prismaRaw.execution.findMany({
      where: { rootExecutionId: executionId, isSubagent: true },
      select: {
        id: true,
        taskId: true,
        parentExecutionId: true,
        rootExecutionId: true,
        subagentType: true,
        isSubagent: true,
      },
      orderBy: { taskId: "asc" },
    })
    assert.equal(children.length, 2)
    assert.deepEqual(children.map((child) => child.taskId), [child1, child2])
    assert.ok(children.every((child) => child.parentExecutionId === executionId))
    assert.ok(children.every((child) => child.rootExecutionId === executionId))
    assert.ok(children.every((child) => child.subagentType === "general-purpose"))
    assert.ok(children.every((child) => child.isSubagent))
  } finally {
    const children = await prismaRaw.execution.findMany({
      where: { rootExecutionId: executionId },
      select: { id: true, taskId: true },
    })
    const executionIds = [executionId, ...children.map((child) => child.id)]
    const taskIds = [taskId, child1, child2, ...children.map((child) => child.taskId).filter(Boolean) as string[]]
    await prismaRaw.executionSkill.deleteMany({ where: { executionId: { in: executionIds } } }).catch(() => undefined)
    await prismaRaw.execution.deleteMany({ where: { id: { in: children.map((child) => child.id) } } })
    await prismaRaw.execution.deleteMany({ where: { id: executionId } })
    await prismaRaw.session.deleteMany({ where: { taskId: { in: taskIds } } })
  }
})

test("claudecode 轮次结束信号: Stop 写 Session.endTime,新一轮活动再清回执行中", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const executionId = `test-claude-turn-end-${suffix}`
  const taskId = `20000000-0000-4000-8000-${suffix.replace(/\D/g, "").padEnd(12, "0").slice(0, 12)}`
  const base = {
    upload_id: executionId,
    task_id: taskId,
    framework: "claudecode",
    query: "一轮任务",
    final_result: "做完了。",
    interactions: [
      { role: "user", content: "做一件事", timestamp: "2026-08-02T10:00:00.000Z", agent: "Claude Code" },
      { role: "assistant", content: "做完了。", timestamp: "2026-08-02T10:00:02.000Z", agent: "Claude Code" },
    ],
    user: "test",
    skip_evaluation: true,
    skip_internal_judgment: true,
  }

  try {
    await saveExecutionRecord({
      ...base,
      executionStatus: "completed",
      trace_completed_at: "2026-08-02T10:00:03.000Z",
    })
    const completed = await prismaRaw.session.findUnique({ where: { taskId } })
    assert.equal(completed?.endTime?.toISOString(), "2026-08-02T10:00:03.000Z")

    // 用户接着开下一轮:聚合器发现最后活动晚于上一次 Stop,回落为执行中。
    await saveExecutionRecord({ ...base, executionStatus: "in_progress" })
    const running = await prismaRaw.session.findUnique({ where: { taskId } })
    assert.equal(running?.endTime, null)
  } finally {
    await prismaRaw.executionSkill.deleteMany({ where: { executionId } }).catch(() => undefined)
    await prismaRaw.execution.deleteMany({ where: { id: executionId } })
    await prismaRaw.session.deleteMany({ where: { taskId } })
  }
})
