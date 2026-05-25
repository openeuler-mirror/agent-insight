import { test } from "node:test"
import assert from "node:assert/strict"
import {
  extractKeyActionsFromFlow,
  mergeKeyActionsFromMultipleSkills,
  ParsedFlowResult,
  ExtractedKeyAction
} from "../src/lib/engine/observability/flow-parser"

test("测试用例 1：线性步骤抽取", () => {
  const input: ParsedFlowResult = {
    steps: [
      { id: "s1", name: "读取配置文件", description: "...", type: "action", controlFlowType: "required" },
      { id: "s2", name: "调用API获取数据", description: "...", type: "action", controlFlowType: "required" },
      { id: "s3", name: "输出结果", description: "...", type: "output", controlFlowType: "required" }
    ]
  }

  const result = extractKeyActionsFromFlow(input)

  assert.equal(result.length, 3)
  assert.equal(result[0].id, "s1")
  assert.equal(result[0].controlFlowType, "required")
  assert.equal(result[0].weight, 1.0)
  assert.equal(result[1].id, "s2")
  assert.equal(result[1].controlFlowType, "required")
  assert.equal(result[1].weight, 1.0)
  assert.equal(result[2].id, "s3")
  assert.equal(result[2].controlFlowType, "required")
  assert.equal(result[2].weight, 1.0)

  assert.equal(result[0].condition, undefined)
  assert.equal(result[0].loopCondition, undefined)
})

test("测试用例 2：条件分支抽取", () => {
  const input: ParsedFlowResult = {
    steps: [
      { id: "s1", name: "判断故障类型", description: "...", type: "decision", controlFlowType: "required" },
      { id: "s2a", name: "检查网络配置", description: "...", type: "action", controlFlowType: "conditional" },
      { id: "s2b", name: "检查磁盘空间", description: "...", type: "action", controlFlowType: "conditional" },
      { id: "s3", name: "输出诊断报告", description: "...", type: "output", controlFlowType: "required" }
    ],
    conditionalGroups: [
      {
        id: "cg-1",
        condition: "根据故障类型选择诊断路径",
        branches: [
          { label: "网络故障", stepIds: ["s2a"] },
          { label: "磁盘故障", stepIds: ["s2b"] }
        ]
      }
    ]
  }

  const result = extractKeyActionsFromFlow(input)

  assert.equal(result.length, 4)
  assert.equal(result[0].id, "s1")
  assert.equal(result[0].controlFlowType, "required")
  assert.equal(result[0].weight, 1.0)

  assert.equal(result[1].id, "s2a")
  assert.equal(result[1].controlFlowType, "conditional")
  assert.equal(result[1].weight, 0.5)
  assert.equal(result[1].condition, "根据故障类型选择诊断路径")
  assert.equal(result[1].branchLabel, "网络故障")
  assert.equal(result[1].groupId, "cg-1")

  assert.equal(result[2].id, "s2b")
  assert.equal(result[2].controlFlowType, "conditional")
  assert.equal(result[2].weight, 0.5)
  assert.equal(result[2].condition, "根据故障类型选择诊断路径")
  assert.equal(result[2].branchLabel, "磁盘故障")
  assert.equal(result[2].groupId, "cg-1")

  assert.equal(result[3].id, "s3")
  assert.equal(result[3].controlFlowType, "required")
  assert.equal(result[3].weight, 1.0)
})

test("测试用例 3：循环动作抽取", () => {
  const input: ParsedFlowResult = {
    steps: [
      { id: "s1", name: "获取服务列表", description: "...", type: "action", controlFlowType: "required" },
      { id: "s2", name: "检查服务进程状态", description: "...", type: "action", controlFlowType: "loop" },
      { id: "s3", name: "验证端口监听", description: "...", type: "action", controlFlowType: "loop" },
      { id: "s4", name: "汇总检查结果", description: "...", type: "output", controlFlowType: "required" }
    ],
    loopGroups: [
      {
        id: "lg-1",
        loopCondition: "对每个受影响的服务执行健康检查",
        bodyStepIds: ["s2", "s3"],
        expectedMinCount: 1,
        expectedMaxCount: 10
      }
    ]
  }

  const result = extractKeyActionsFromFlow(input)

  assert.equal(result.length, 4)
  assert.equal(result[0].id, "s1")
  assert.equal(result[0].controlFlowType, "required")
  assert.equal(result[0].weight, 1.0)

  assert.equal(result[1].id, "s2")
  assert.equal(result[1].controlFlowType, "loop")
  assert.equal(result[1].weight, 1.0)
  assert.equal(result[1].loopCondition, "对每个受影响的服务执行健康检查")
  assert.equal(result[1].expectedMinCount, 1)
  assert.equal(result[1].expectedMaxCount, 10)
  assert.equal(result[1].groupId, "lg-1")

  assert.equal(result[2].id, "s3")
  assert.equal(result[2].controlFlowType, "loop")
  assert.equal(result[2].weight, 1.0)
  assert.equal(result[2].loopCondition, "对每个受影响的服务执行健康检查")
  assert.equal(result[2].expectedMinCount, 1)
  assert.equal(result[2].expectedMaxCount, 10)
  assert.equal(result[2].groupId, "lg-1")

  assert.equal(result[3].id, "s4")
  assert.equal(result[3].controlFlowType, "required")
  assert.equal(result[3].weight, 1.0)
})

test("测试用例 4：可选步骤抽取", () => {
  const input: ParsedFlowResult = {
    steps: [
      { id: "s1", name: "执行主流程", description: "...", type: "action", controlFlowType: "required", isOptional: false },
      { id: "s2", name: "发送告警通知", description: "...", type: "action", isOptional: true }
    ]
  }

  const result = extractKeyActionsFromFlow(input)

  assert.equal(result.length, 2)
  assert.equal(result[0].id, "s1")
  assert.equal(result[0].controlFlowType, "required")
  assert.equal(result[0].weight, 1.0)

  assert.equal(result[1].id, "s2")
  assert.equal(result[1].controlFlowType, "optional")
  assert.equal(result[1].weight, 0)
})

test("测试用例 5：多 Skill 合并", () => {
  const input = [
    {
      name: "skill-A",
      actions: [
        { id: "a1", content: "步骤A1", weight: 1.0, controlFlowType: "required" } as ExtractedKeyAction,
        { id: "a2", content: "步骤A2", weight: 1.0, controlFlowType: "required" } as ExtractedKeyAction
      ]
    },
    {
      name: "skill-B",
      actions: [
        { id: "b1", content: "步骤B1", weight: 1.0, controlFlowType: "required" } as ExtractedKeyAction
      ]
    }
  ]

  const result = mergeKeyActionsFromMultipleSkills(input)

  assert.equal(result.length, 4)

  assert.equal(result[0].id, "skill-A-a1")
  assert.equal(result[0].content, "步骤A1")
  assert.equal(result[0].skillSource, "skill-A")

  assert.equal(result[1].id, "skill-A-a2")
  assert.equal(result[1].content, "步骤A2")
  assert.equal(result[1].skillSource, "skill-A")

  assert.equal(result[2].id, "handoff-skill-A-to-skill-B")
  assert.equal(result[2].content, "从 skill-A 输出衔接至 skill-B 输入")
  assert.equal(result[2].controlFlowType, "handoff")
  assert.equal(result[2].weight, 1.0)
  assert.equal(result[2].skillSource, "skill-A->skill-B")

  assert.equal(result[3].id, "skill-B-b1")
  assert.equal(result[3].content, "步骤B1")
  assert.equal(result[3].skillSource, "skill-B")
})

test("测试用例 6：降级处理 - 无效的 stepId 引用", () => {
  const input: ParsedFlowResult = {
    steps: [
      { id: "s1", name: "判断故障类型", description: "...", type: "decision", controlFlowType: "required" },
      { id: "s2a", name: "检查网络配置", description: "...", type: "action", controlFlowType: "conditional" }
    ],
    conditionalGroups: [
      {
        id: "cg-1",
        condition: "根据故障类型选择诊断路径",
        branches: [
          { label: "网络故障", stepIds: ["s2a"] },
          { label: "磁盘故障", stepIds: ["s2b-invalid"] }
        ]
      }
    ]
  }

  const result = extractKeyActionsFromFlow(input)

  assert.equal(result.length, 2)
  assert.equal(result[0].id, "s1")
  assert.equal(result[0].controlFlowType, "required")

  assert.equal(result[1].id, "s2a")
  assert.equal(result[1].controlFlowType, "conditional")
  assert.equal(result[1].groupId, "cg-1")
})

test("额外测试：多个条件分支组", () => {
  const input: ParsedFlowResult = {
    steps: [
      { id: "s1", name: "步骤1", description: "...", type: "decision", controlFlowType: "required" },
      { id: "s2a", name: "分支A", description: "...", type: "action", controlFlowType: "conditional" },
      { id: "s2b", name: "分支B", description: "...", type: "action", controlFlowType: "conditional" },
      { id: "s3", name: "步骤3", description: "...", type: "decision", controlFlowType: "required" },
      { id: "s4a", name: "分支C", description: "...", type: "action", controlFlowType: "conditional" },
      { id: "s4b", name: "分支D", description: "...", type: "action", controlFlowType: "conditional" },
      { id: "s5", name: "结束", description: "...", type: "output", controlFlowType: "required" }
    ],
    conditionalGroups: [
      {
        id: "cg-1",
        condition: "第一个条件",
        branches: [
          { label: "选项A", stepIds: ["s2a"] },
          { label: "选项B", stepIds: ["s2b"] }
        ]
      },
      {
        id: "cg-2",
        condition: "第二个条件",
        branches: [
          { label: "选项C", stepIds: ["s4a"] },
          { label: "选项D", stepIds: ["s4b"] }
        ]
      }
    ]
  }

  const result = extractKeyActionsFromFlow(input)

  assert.equal(result.length, 7)
  assert.equal(result[1].groupId, "cg-1")
  assert.equal(result[2].groupId, "cg-1")
  assert.equal(result[4].groupId, "cg-2")
  assert.equal(result[5].groupId, "cg-2")
})

test("额外测试：isOptional 属性回退到 controlFlowType", () => {
  const input: ParsedFlowResult = {
    steps: [
      { id: "s1", name: "必选步骤", description: "...", type: "action", isOptional: false },
      { id: "s2", name: "可选步骤", description: "...", type: "action", isOptional: true }
    ]
  }

  const result = extractKeyActionsFromFlow(input)

  assert.equal(result.length, 2)
  assert.equal(result[0].controlFlowType, "required")
  assert.equal(result[0].weight, 1.0)
  assert.equal(result[1].controlFlowType, "optional")
  assert.equal(result[1].weight, 0)
})

test("额外测试：空的 conditionalGroups 和 loopGroups", () => {
  const input: ParsedFlowResult = {
    steps: [
      { id: "s1", name: "步骤1", description: "...", type: "action" },
      { id: "s2", name: "步骤2", description: "...", type: "action" }
    ],
    conditionalGroups: [],
    loopGroups: []
  }

  const result = extractKeyActionsFromFlow(input)

  assert.equal(result.length, 2)
  assert.equal(result[0].controlFlowType, "required")
  assert.equal(result[1].controlFlowType, "required")
})

test("额外测试：单个 Skill 合并（无 handoff）", () => {
  const input = [
    {
      name: "skill-A",
      actions: [
        { id: "a1", content: "步骤A1", weight: 1.0, controlFlowType: "required" } as ExtractedKeyAction
      ]
    }
  ]

  const result = mergeKeyActionsFromMultipleSkills(input)

  assert.equal(result.length, 1)
  assert.equal(result[0].id, "skill-A-a1")
})
