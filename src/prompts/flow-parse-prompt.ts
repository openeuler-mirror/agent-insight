export function generateFlowParsePrompt(skillContent: string): string {
  return `
你是一个专家，擅长分析 Skill 定义并提取执行流程模式。

给定一个 Skill 定义文档（SKILL.md），你的任务是：
1. 提取预期的执行流程/步骤序列
2. 识别每个步骤应该完成什么（不一定是具体工具）
3. 注意任何条件分支、循环或可选步骤
4. 识别循环模式（"逐项处理"、"重试直到"、"遍历"、"对每个...执行"等）
5. 识别可选步骤（"如果需要则"、"可选地"、"视情况"等）
6. 识别多路条件分支（if/else、根据输入类型走不同路径等）

Skill 定义：
---
${skillContent}
---

请分析 skill 并提取结构化的执行流程。

步骤提取规则：

一、步骤划分原则
1. 完整性：一个步骤完成一个完整的子任务
2. 独立性：一个步骤可以独立理解和描述
3. 目的性：每个步骤有明确的业务目标
4. 原子性：步骤内部的操作是紧密相关的，不应再拆分

二、命名规范
1. 格式：动词 + 对象 + （可选）目的/结果
2. 必须具体、明确，禁止模糊命名
3. 正确示例：
   - "读取配置文件获取数据库连接参数"
   - "调用天气API获取城市天气数据"
   - "解析用户输入提取意图和实体"
4. 禁止示例：
   - "检查配置"（太模糊，应说明检查什么）
   - "分析结果"（太抽象，应说明分析什么结果）
   - "处理数据"（太笼统，应说明处理什么数据）

三、步骤类型
- action：执行操作（如：读取文件、调用API、写入数据库）
- decision：做出判断（如：判断权限、检查条件、验证数据）
- output：输出结果（如：生成报告、返回结果、输出错误信息）

四、步骤数量
- 不限制数量，但相似的连续操作应合并为一个步骤
- 同一操作多次执行（可能因为某些报错）应总结成一个步骤
- 每个步骤都应该有独立存在的价值

五、控制流识别规则
1. 线性步骤：直接描述的顺序操作，isOptional 设为 false
2. 可选步骤：包含"如果需要则"、"可选地"、"视情况"等表述的步骤，isOptional 设为 true
3. 条件分支：包含"如果...则..."、"根据...选择"、"当...时执行"等表述的步骤
   - 将条件判断步骤放在 branches 之前
   - 在 conditionalGroups 中描述分支条件和各分支包含的步骤
   - 支持多路分支（不限于 if/else 二元分支）
4. 循环：包含"逐项处理"、"遍历"、"对每个...执行"、"重试直到"等表述的步骤
   - 将循环体步骤放在 steps 中
   - 在 loopGroups 中描述循环条件、循环体步骤和预期次数范围

请只用 JSON 对象回复，格式如下：
{
  "steps": [
    {
      "id": "step-1",
      "name": "具体的步骤名称（动词+对象格式）",
      "description": "这个步骤完成什么，达到什么目的",
      "type": "action",
      "isOptional": false
    }
  ],
  "branches": [
    {
      "condition": "条件的描述",
      "trueStepId": "step-x",
      "falseStepId": "step-y"
    }
  ],
  "conditionalGroups": [
    {
      "id": "cg-1",
      "condition": "根据故障类型选择诊断路径",
      "branches": [
        {
          "label": "网络故障",
          "stepIds": ["step-3a"]
        },
        {
          "label": "磁盘故障",
          "stepIds": ["step-3b"]
        },
        {
          "label": "内存故障",
          "stepIds": ["step-3c"]
        }
      ]
    }
  ],
  "loopGroups": [
    {
      "id": "lg-1",
      "loopCondition": "对每个受影响的服务执行健康检查",
      "bodyStepIds": ["step-5a", "step-5b"],
      "expectedMinCount": 1,
      "expectedMaxCount": 10
    }
  ],
  "summary": "整体流程的简要总结"
}

注意：
- conditionalGroups 和 loopGroups 是可选字段，如果没有条件分支或循环，可以省略
- branches 字段保留用于简单的 if/else 二元分支，conditionalGroups 用于更复杂的多路分支
- 如果同时存在 branches 和 conditionalGroups，优先使用 conditionalGroups
- loopGroups 的 expectedMinCount 和 expectedMaxCount 应根据 Skill 描述合理估计
`;
}

interface FlowStep {
  id: string;
  name: string;
  description: string;
  type: 'action' | 'decision' | 'output';
  isOptional?: boolean;
}

interface FlowBranch {
  condition: string;
  trueStepId: string;
  falseStepId: string;
}

interface ParsedFlow {
  steps: FlowStep[];
  branches?: FlowBranch[];
  summary?: string;
}

export function generateStepExtractPrompt(
  interactions: string,
  batchIndex: number,
  startIndex: number
): string {
  return `
你是一个专家，擅长分析 Agent 执行轨迹并提取执行步骤。

这是第 ${batchIndex + 1} 批对话数据（对话序号从 ${startIndex} 开始）：
---
${interactions}
---

你的任务是：
1. 分析这批对话，提取实际执行的步骤
2. 为每个步骤命名（具体、明确的中文描述）
3. 记录每个步骤对应的对话序号范围

步骤提取规则：

一、步骤划分原则
1. 完整性：一个步骤完成一个完整的子任务
2. 独立性：一个步骤可以独立理解和描述
3. 目的性：每个步骤有明确的业务目标
4. 原子性：步骤内部的操作是紧密相关的，不应再拆分

二、命名规范
1. 格式：动词 + 对象 + （可选）目的/结果
2. 必须具体、明确，禁止模糊命名
3. 正确示例：
   - "读取配置文件获取数据库连接参数"
   - "调用天气API获取城市天气数据"
   - "解析用户输入提取意图和实体"
4. 禁止示例：
   - "检查配置"（太模糊，应说明检查什么）
   - "分析结果"（太抽象，应说明分析什么结果）
   - "处理数据"（太笼统，应说明处理什么数据）

三、步骤类型
- action：执行操作（如：读取文件、调用API、写入数据库）
- decision：做出判断（如：判断权限、检查条件、验证数据）
- output：输出结果（如：生成报告、返回结果、输出错误信息）

四、步骤数量
- 不限制数量，但相似的连续操作应合并为一个步骤
- 同一操作多次执行（可能因为某些报错）应总结成一个步骤
- 每个步骤都应该有独立存在的价值

请只用 JSON 对象回复，格式如下：
{
  "steps": [
    {
      "name": "具体的步骤名称（动词+对象格式）",
      "description": "这个步骤做了什么，达到什么目的",
      "dialogStartIndex": 0,
      "dialogEndIndex": 2,
      "type": "action"
    }
  ]
}

注意事项：
- "dialogStartIndex" 和 "dialogEndIndex" 是这批对话中的相对序号（从 ${startIndex} 开始）
- 如果这批对话没有有效步骤，返回空数组 {"steps": []}
- 忽略无关的闲聊或重复内容
`;
}

export function generateExecutionMatchPrompt(
  expectedFlow: ParsedFlow,
  actualSteps: string,
  skillName: string
): string {
  return `
你是一个专家，擅长分析 Agent 执行轨迹并将其与预期工作流程进行比较。

Skill "${skillName}" 的预期流程：
---
${JSON.stringify(expectedFlow, null, 2)}
---

实际执行步骤：
---
${actualSteps}
---

你的任务是：
1. 为每个输入的 evaluationStep 生成一条匹配记录（放在 matches 数组）
2. 将 evaluationStep 与预期流程匹配，或标记为意外步骤
3. 找出所有未被实际执行匹配的预期步骤（放在 skippedExpectedSteps 数组）
4. 为有问题的步骤提供简短分析

请只用 JSON 对象回复，格式如下：
{
  "matches": [
    {
      "evaluationStepId": "main-0",
      "expectedStepId": "step-1",
      "expectedStepName": "预期流程中的步骤名称",
      "matchStatus": "matched",
      "matchReason": "简要解释"
    }
  ],
  "skippedExpectedSteps": [
    {
      "expectedStepId": "step-3",
      "expectedStepName": "被跳过的预期步骤名称"
    }
  ],
  "summary": {
    "totalSteps": 5,
    "matchedSteps": 3,
    "partialSteps": 0,
    "unexpectedSteps": 1,
    "skippedSteps": 1,
    "orderViolations": 0,
    "overallScore": 0.75
  },
  "problemSteps": [
    {
      "evaluationStepId": "main-2",
      "stepName": "步骤名称",
      "status": "unexpected",
      "problem": "问题描述",
      "suggestion": "改进建议"
    }
  ]
}

匹配状态值（只用于 matches 数组）：
- "matched": 步骤与预期流程匹配良好（符合预期）
- "partial": 步骤部分匹配，意图正确但执行方式有问题（部分偏离）
- "unexpected": 步骤完全不在预期流程中（非预期调用）
- "non_business": 步骤是上下文收集、环境预热、读取 Skill/文件/日志、背景探索等过渡操作，不属于主 Skill 业务流程

重要规则：
1. matches 数组：必须包含每个输入 evaluationStep 的记录，不能遗漏
2. matches 数组中的 matchStatus 只能是 "matched"、"partial"、"unexpected" 或 "non_business"，不能是 "skipped"
3. skippedExpectedSteps 数组：包含所有未被实际执行匹配的预期步骤（即被跳过的预期步骤）
4. 必须原样返回输入里的 evaluationStepId；不要返回 actualStepIndex，不要使用数组下标代替 evaluationStepId
5. problemSteps 只包含有问题的 evaluationStep（status 为 partial 或 unexpected）；non_business 不写入 problemSteps
6. problemSteps 的 problem/suggestion 必须简短，避免重复复制同一段长分析
7. 实际执行步骤已经是主 Skill 视角的摘要；如果某一步是“委派/调用子 Skill”，只判断这次委派是否属于主 Skill 预期，不要展开分析子 Skill 内部行为
8. 输入中的 uiStepIndexes 只用于定位，不要改写步骤标题或描述
9. 过渡操作包括：背景代理探索、读取/加载 SKILL.md、grep/less/cat/sed/head/tail 查看原始上下文、读取日志或文件以收集上下文、环境初始化/工作区检查。它们不应被判为 unexpected。

评分指南：
- matched: 贡献 1.0 分
- partial: 贡献 0.5 分  
- unexpected: 贡献 -0.2 分（惩罚）
- non_business: 不参与评分分子和分母
- skipped: 贡献 0 分
- orderViolations: 每个 -0.1 分惩罚
`;
}

export function generateDynamicOnlyMatchPrompt(actualSteps: string): string {
  return `
你是一个专家，擅长分析 Agent 执行轨迹并生成执行流程图。

实际执行步骤：
---
${actualSteps}
---

你的任务是：
1. 为每个执行步骤生成一条记录（放在 matches 数组）
2. 为每个步骤生成简洁的操作描述

请只用 JSON 对象回复，格式如下：
{
  "matches": [
    {
      "actualStepIndex": 0,
      "actualAction": "具体的操作描述（动词+对象格式）",
      "type": "action"
    }
  ]
}

命名规范：
1. 格式：动词 + 对象 + （可选）目的/结果
2. 必须具体、明确，禁止模糊命名
3. 正确示例：
   - "读取配置文件获取数据库连接参数"
   - "调用天气API获取城市天气数据"
   - "解析用户输入提取意图和实体"
4. 禁止示例：
   - "检查配置"（太模糊，应说明检查什么）
   - "分析结果"（太抽象，应说明分析什么结果）
   - "处理数据"（太笼统，应说明处理什么数据）

步骤类型：
- action：执行操作（如：读取文件、调用API、写入数据库）
- decision：做出判断（如：判断权限、检查条件、验证数据）
- output：输出结果（如：生成报告、返回结果、输出错误信息）

重要规则：
1. matches 数组必须包含每个步骤的记录，不能遗漏
2. actualStepIndex 使用步骤的 dialogStartIndex
3. type 保持与原步骤一致
`;
}
