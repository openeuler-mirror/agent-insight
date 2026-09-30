import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentTrajectoryContractExhaustedError,
  runAgentTrajectoryJudge,
} from '@/lib/engine/evaluation/agent-trajectory-judge';
import {
  extractAgentTrajectoryFacts,
  promptAgentTrajectoryFacts,
  TrajectoryPromptTooLargeError,
} from '@/lib/engine/evaluation/agent-trajectory-facts';
import {
  runAgentTrajectoryPreset,
} from '@/lib/engine/experiment/agent-trajectory-preset-evaluators';
import {
  setJudgeLlmCallerForTest,
  type JudgeLlmRequest,
} from '@/lib/engine/experiment/judge-llm';
import { buildAgentStepEfficiencyPrompt } from '@/prompts/agent-step-efficiency-prompt';
import { buildAgentProcessQualityPrompt } from '@/prompts/agent-process-quality-prompt';

type Kind = 'step-efficiency' | 'process-quality';
type IssueCode =
  | 'duplicate_no_gain'
  | 'irrelevant_detour'
  | 'unchanged_retry_loop'
  | 'avoidable_llm_overuse'
  | 'fragmented_mergeable_steps'
  | 'excessive_detour'
  | 'unused_tool_result_processing'
  | 'overrollback'
  | 'goal_drift'
  | 'missing_required_step'
  | 'unsupported_reasoning_jump'
  | 'unhandled_recoverable_error'
  | 'contradicted_tool_result'
  | 'decision_thrashing'
  | 'internal_contradiction'
  | 'unused_required_information';

interface PromptEnvelope {
  task: string;
  trajectoryFacts: {
    steps: Array<{
      index: number;
      kind?: string;
      name?: string;
      argsSummary?: string;
      outputSummary?: string;
      textSummary?: string;
    }>;
    candidates: Record<string, Array<{ stepIndexes: number[] }>>;
  };
  rubric: {
    kind: Kind;
    dimensions: string[];
    issueCodes: string[];
    issueRules: Array<{
      code: IssueCode;
      dimension: string;
      trigger: string;
      doNotTriggerWhen: string;
    }>;
    dimensionRules: Array<{
      dimension: string;
      definition: string;
      allowedIssueCodes: IssueCode[];
      exclusions: string[];
    }>;
    mechanicalRules: {
      stepIndexes: string[];
      candidateRequirements: Record<string, string>;
      toolName: string[];
      verdictIssueConsistency: string[];
      stringFields: string[];
      evaluationOrder: string[];
    };
  };
}

interface ScenarioIssue {
  code: IssueCode;
  dimension: string;
  candidateKey?: string;
  stepIndexes?: number[];
  toolName?: string;
}

interface Scenario {
  number: number;
  title: string;
  task: string;
  interactions: unknown[];
  allowedIssueCodes: IssueCode[];
  forbiddenIssueCodes: IssueCode[];
  issue?: ScenarioIssue;
  total?: number;
  totalMin?: number;
  totalMax?: number;
  dimension?: string;
  dimensionMin?: number;
  dimensionMax?: number;
  extraDimension?: string;
  extraDimensionMax?: number;
  allDimensionsMin?: number;
}

const EFFICIENCY_DIMENSIONS = [
  'step_necessity',
  'path_detour',
  'cost_efficiency',
  'step_density',
  'retry_efficiency',
] as const;

const QUALITY_DIMENSIONS = [
  'goal_alignment',
  'planning_completeness',
  'reasoning_coherence',
  'exception_handling',
  'path_robustness',
  'information_utilization',
] as const;

const EFFICIENCY_ISSUE_CODES: IssueCode[] = [
  'duplicate_no_gain',
  'irrelevant_detour',
  'unchanged_retry_loop',
  'avoidable_llm_overuse',
  'fragmented_mergeable_steps',
  'excessive_detour',
  'unused_tool_result_processing',
  'overrollback',
];

const QUALITY_ISSUE_CODES: IssueCode[] = [
  'goal_drift',
  'missing_required_step',
  'unsupported_reasoning_jump',
  'unhandled_recoverable_error',
  'contradicted_tool_result',
  'decision_thrashing',
  'internal_contradiction',
  'unused_required_information',
];

function issuePolicy(kind: Kind, ...allowedIssueCodes: IssueCode[]): Pick<
  Scenario,
  'allowedIssueCodes' | 'forbiddenIssueCodes'
> {
  const codes = kind === 'step-efficiency' ? EFFICIENCY_ISSUE_CODES : QUALITY_ISSUE_CODES;
  return {
    allowedIssueCodes,
    forbiddenIssueCodes: codes.filter(code => !allowedIssueCodes.includes(code)),
  };
}

const ISSUE_DIMENSIONS: Record<IssueCode, string> = {
  duplicate_no_gain: 'step_necessity',
  irrelevant_detour: 'path_detour',
  unchanged_retry_loop: 'retry_efficiency',
  avoidable_llm_overuse: 'cost_efficiency',
  fragmented_mergeable_steps: 'step_density',
  excessive_detour: 'path_detour',
  unused_tool_result_processing: 'cost_efficiency',
  overrollback: 'retry_efficiency',
  goal_drift: 'goal_alignment',
  missing_required_step: 'planning_completeness',
  unsupported_reasoning_jump: 'reasoning_coherence',
  unhandled_recoverable_error: 'exception_handling',
  contradicted_tool_result: 'information_utilization',
  decision_thrashing: 'path_robustness',
  internal_contradiction: 'reasoning_coherence',
  unused_required_information: 'information_utilization',
};

const PROMPT_RULE_SEMANTICS: Record<Kind, ReadonlyArray<{
  code: IssueCode;
  dimension: string;
  trigger: RegExp;
  doNotTriggerWhen: RegExp;
}>> = {
  'step-efficiency': [
    { code: 'duplicate_no_gain', dimension: 'step_necessity', trigger: /同参.*(?:没有|无)新增信息.*repeatedSameResultCandidates/, doNotTriggerWhen: /分页.*分片.*轮询.*幂等/ },
    { code: 'irrelevant_detour', dimension: 'path_detour', trigger: /主任务.*无关.*探索|上下文切换/, doNotTriggerWhen: /明确依赖.*必要验证.*消歧.*错误恢复/ },
    { code: 'unchanged_retry_loop', dimension: 'retry_efficiency', trigger: /失败.*参数.*策略.*未改变.*unchangedRetryCandidates/, doNotTriggerWhen: /调整.*参数.*策略.*退避/ },
    { code: 'avoidable_llm_overuse', dimension: 'cost_efficiency', trigger: /LLM.*重复.*转述.*已有确定信息/, doNotTriggerWhen: /动作完成.*状态确认.*解释.*汇总.*转换.*决策/ },
    { code: 'fragmented_mergeable_steps', dimension: 'step_density', trigger: /同类.*安全合并.*consecutiveSimilarCandidates/, doNotTriggerWhen: /数据依赖.*分页分片.*限流.*串行.*长路径偏航.*不得触发/ },
    { code: 'excessive_detour', dimension: 'path_detour', trigger: /非必要探索.*延后核心动作.*长路径偏航/, doNotTriggerWhen: /必要前置.*验证关键假设.*消歧.*恢复失败/ },
    { code: 'unused_tool_result_processing', dimension: 'cost_efficiency', trigger: /工具.*output.*完整内容.*近似复述.*不是.*状态确认/, doNotTriggerWhen: /正常读取.*一次必要回答.*不得触发/ },
    { code: 'overrollback', dimension: 'retry_efficiency', trigger: /局部失败.*前序成果.*无依据重做/, doNotTriggerWhen: /依赖状态失效.*一致性.*安全要求/ },
  ],
  'process-quality': [
    { code: 'goal_drift', dimension: 'goal_alignment', trigger: /目标.*无依据扩大.*替换.*持续偏离/, doNotTriggerWhen: /手段.*原始目标.*缺少依据.*遗漏验证.*不得触发/ },
    { code: 'missing_required_step', dimension: 'planning_completeness', trigger: /用户明确要求.*显式前置关系.*关键动作.*必需的验证/, doNotTriggerWhen: /行业习惯.*隐藏标准.*不得触发/ },
    { code: 'unsupported_reasoning_jump', dimension: 'reasoning_coherence', trigger: /关键决策.*缺少.*事实.*工具结果.*必要检查/, doNotTriggerWhen: /可观察事实.*直接支持.*无需额外检查/ },
    { code: 'unhandled_recoverable_error', dimension: 'exception_handling', trigger: /可恢复错误.*未.*重试.*参数调整.*降级/, doNotTriggerWhen: /错误不可恢复.*继续操作不安全.*合理恢复.*降级/ },
    { code: 'contradicted_tool_result', dimension: 'information_utilization', trigger: /后续结论.*关键工具事实.*直接矛盾/, doNotTriggerWhen: /更新证据.*取代旧结果.*并不冲突/ },
    { code: 'decision_thrashing', dimension: 'path_robustness', trigger: /没有新证据.*约束变化.*至少两次.*反复切换/, doNotTriggerWhen: /新证据.*失败反馈.*约束变化.*不同工具.*无关步骤.*目标.*偏移.*不得触发/ },
    { code: 'internal_contradiction', dimension: 'reasoning_coherence', trigger: /不同可观察步骤.*同一关键事实.*直接冲突/, doNotTriggerWhen: /新证据.*修正旧结论.*不同条件/ },
    { code: 'unused_required_information', dimension: 'information_utilization', trigger: /可观察工具结果.*明确返回.*任务要求.*必要字段.*最终.*遗漏/, doNotTriggerWhen: /任务文本.*普通上下文.*没有.*工具返回.*不得触发/ },
  ],
};

const DIMENSION_RULE_SEMANTICS: Record<Kind, ReadonlyArray<{
  dimension: string;
  definition: RegExp;
  allowedIssueCodes: IssueCode[];
  exclusions: RegExp[];
}>> = {
  'step-efficiency': [
    {
      dimension: 'step_necessity',
      definition: /每一步.*目标.*必要验证.*合理恢复/,
      allowedIssueCodes: ['duplicate_no_gain'],
      exclusions: [
        /重试.*retry_efficiency.*不得/,
        /LLM.*重复.*cost_efficiency.*不得/,
        /excessive_detour.*附加影响.*代码.*不得/,
      ],
    },
    {
      dimension: 'path_detour',
      definition: /可避免.*偏航.*上下文切换.*长路径/,
      allowedIssueCodes: ['irrelevant_detour', 'excessive_detour'],
      exclusions: [/必要前置.*验证.*消歧.*恢复.*不得/, /excessive_detour.*优先.*irrelevant_detour/],
    },
    {
      dimension: 'cost_efficiency',
      definition: /可证实.*无信息增量.*LLM.*处理浪费/,
      allowedIssueCodes: ['avoidable_llm_overuse', 'unused_tool_result_processing'],
      exclusions: [/重试.*overrollback.*retry_efficiency.*不得/, /duplicate_no_gain.*优先.*不得/],
    },
    {
      dimension: 'step_density',
      definition: /步骤粒度.*安全合并/,
      allowedIssueCodes: ['fragmented_mergeable_steps'],
      exclusions: [
        /数据依赖.*分页.*分片.*限流.*串行.*不得/,
        /长路径偏航.*同一组.*步骤.*不得.*fragmented_mergeable_steps/,
      ],
    },
    {
      dimension: 'retry_efficiency',
      definition: /失败后.*参数.*策略.*回退范围/,
      allowedIssueCodes: ['unchanged_retry_loop', 'overrollback'],
      exclusions: [/重试问题.*不得.*cost_efficiency.*step_necessity/],
    },
  ],
  'process-quality': [
    {
      dimension: 'goal_alignment',
      definition: /关键动作.*最终结果.*原始目标/,
      allowedIssueCodes: ['goal_drift'],
      exclusions: [/结果不完整.*结果不正确.*goal_drift.*不得/],
    },
    {
      dimension: 'planning_completeness',
      definition: /执行路径.*必要前置.*子任务.*验证/,
      allowedIssueCodes: ['missing_required_step'],
      exclusions: [/没有显式计划.*不得/],
    },
    {
      dimension: 'reasoning_coherence',
      definition: /可观察决策.*前序证据.*前后一致/,
      allowedIssueCodes: ['unsupported_reasoning_jump', 'internal_contradiction'],
      exclusions: [/工具事实冲突.*information_utilization.*不得/],
    },
    {
      dimension: 'exception_handling',
      definition: /可恢复错误.*重试.*调整.*降级/,
      allowedIssueCodes: ['unhandled_recoverable_error'],
      exclusions: [/没有错误.*met/],
    },
    {
      dimension: 'path_robustness',
      definition: /方案切换.*新证据.*稳定/,
      allowedIssueCodes: ['decision_thrashing'],
      exclusions: [/少于两次.*无新证据.*切换.*不得/],
    },
    {
      dimension: 'information_utilization',
      definition: /上下文.*工具返回.*中间状态.*正确.*充分使用/,
      allowedIssueCodes: ['contradicted_tool_result', 'unused_required_information'],
      exclusions: [
        /数值.*布尔.*直接冲突/,
        /unused_required_information.*可观察工具结果.*明确返回.*必要字段.*最终.*遗漏/,
        /任务文本.*普通上下文.*没有.*工具返回.*不得触发/,
      ],
    },
  ],
};

const presetId = (kind: Kind) => kind === 'step-efficiency'
  ? 'preset-agent-step-efficiency' as const
  : 'preset-agent-process-quality' as const;

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  state: 'success' | 'error' | 'timeout' = 'success',
  output: unknown = { ok: true },
) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
    state,
    output,
  };
}

function messageTrace(task: string, ...messages: string[]): unknown[] {
  return [
    { role: 'user', content: task },
    ...messages.map(content => ({ role: 'assistant', content })),
  ];
}

function toolTrace(task: string, calls: unknown[], conclusion: string | string[] = '已完成任务。'): unknown[] {
  const conclusions = Array.isArray(conclusion) ? conclusion : [conclusion];
  return [
    { role: 'user', content: task },
    { role: 'assistant', content: '开始执行。', tool_calls: calls },
    ...conclusions.map(content => ({ role: 'assistant', content })),
  ];
}

function sequentialToolTrace(task: string, calls: unknown[], conclusion = '已完成任务。'): unknown[] {
  return [
    { role: 'user', content: task },
    ...calls.map((call, index) => ({
      role: 'assistant',
      content: `执行第 ${index + 1} 个工具步骤。`,
      tool_calls: [call],
    })),
    { role: 'assistant', content: conclusion },
  ];
}

function buildJudgment(
  kind: Kind,
  issue?: ScenarioIssue,
  stepIndexes: number[] = issue?.stepIndexes ?? [1],
) {
  const dimensions = (kind === 'step-efficiency' ? EFFICIENCY_DIMENSIONS : QUALITY_DIMENSIONS)
    .map(dimension => ({
      dimension,
      verdict: issue && dimension === issue.dimension ? 'partial' as const : 'met' as const,
      reason: issue && dimension === issue.dimension ? '轨迹中存在已锚定的问题。' : '可观察轨迹满足该维度。',
      suggestion: issue && dimension === issue.dimension ? '移除问题并保留必要步骤。' : '',
    }));
  return {
    summary: issue ? `检测到 ${issue.code}。` : '轨迹直接、完整且稳定。',
    dimensions,
    issues: issue ? [{
      code: issue.code,
      severity: 'critical',
      dimension: ISSUE_DIMENSIONS[issue.code],
      stepIndexes,
      ...(issue.toolName ? { toolName: issue.toolName } : {}),
      reason: '这些步骤提供了可观察证据。',
      suggestion: '按任务目标收敛执行路径。',
    }] : [],
  };
}

function context(task: string, interactions: unknown[]) {
  return {
    caseInput: task,
    actualOutput: '完成',
    referenceOutput: null,
    traceSummaryText: null,
    interactions,
    taskId: null,
    executionId: null,
    execution: null,
  };
}

function pointScore(output: Awaited<ReturnType<typeof runAgentTrajectoryPreset>>, dimension: string): number | undefined {
  return pointFor(output, dimension)?.score;
}

function pointFor(output: Awaited<ReturnType<typeof runAgentTrajectoryPreset>>, dimension: string) {
  return output.points?.find(point => (
    (point.evidence as { json?: { dimension?: string } } | undefined)?.json?.dimension === dimension
  ));
}

function evidenceJson(output: Awaited<ReturnType<typeof runAgentTrajectoryPreset>>) {
  return (output.evidence as { json?: Record<string, unknown> } | undefined)?.json ?? {};
}

function assertScenarioIssuePolicy(
  kind: Kind,
  scenario: Scenario,
  output: Awaited<ReturnType<typeof runAgentTrajectoryPreset>>,
) {
  const universe = kind === 'step-efficiency' ? EFFICIENCY_ISSUE_CODES : QUALITY_ISSUE_CODES;
  assert.deepEqual(
    [...new Set([...scenario.allowedIssueCodes, ...scenario.forbiddenIssueCodes])].sort(),
    [...universe].sort(),
    `${kind} ${scenario.number}: issue policy must cover the complete taxonomy`,
  );
  assert.deepEqual(
    scenario.allowedIssueCodes.filter(code => scenario.forbiddenIssueCodes.includes(code)),
    [],
    `${kind} ${scenario.number}: allowed and forbidden issue codes must be disjoint`,
  );
  const issues = (evidenceJson(output).issues ?? []) as Array<{ code?: IssueCode; toolName?: string }>;
  const issueCodes = issues.map(issue => issue.code).filter((code): code is IssueCode => Boolean(code));
  assert.ok(
    issueCodes.every(code => scenario.allowedIssueCodes.includes(code)),
    `${kind} ${scenario.number}: unexpected issue codes ${JSON.stringify(issueCodes)}`,
  );
  assert.ok(
    scenario.forbiddenIssueCodes.every(code => !issueCodes.includes(code)),
    `${kind} ${scenario.number}: a forbidden issue code was emitted`,
  );
  if (scenario.allowedIssueCodes.length === 0) {
    assert.deepEqual(issueCodes, [], `${kind} ${scenario.number}: positive scenario must have no issues`);
  }
  if (scenario.issue) {
    assert.ok(issueCodes.includes(scenario.issue.code), `${kind} ${scenario.number}: required issue missing`);
    if (scenario.issue.toolName) {
      assert.ok(
        issues.some(issue => issue.code === scenario.issue?.code && issue.toolName === scenario.issue?.toolName),
        `${kind} ${scenario.number}: required toolName missing from issue`,
      );
    }
  }
}

async function runScenario(kind: Kind, scenario: Scenario) {
  setJudgeLlmCallerForTest(async (_user, request) => {
    const envelope = JSON.parse(request.user) as PromptEnvelope;
    const indexes = scenario.issue?.candidateKey
      ? envelope.trajectoryFacts.candidates[scenario.issue.candidateKey]?.[0]?.stepIndexes
      : scenario.issue?.stepIndexes;
    return JSON.stringify(buildJudgment(kind, scenario.issue, indexes));
  });
  return runAgentTrajectoryPreset(presetId(kind), 'scenario-user', context(scenario.task, scenario.interactions));
}

test.afterEach(() => setJudgeLlmCallerForTest(null));

test('judge boundary: request carries task, complete prompt facts, candidates and rubric without scoring controls', async () => {
  const task = '查询一次库存并直接回答。';
  const interactions = toolTrace(task, [
    toolCall('inventory-1', 'inventory', { sku: 'A' }, 'success', { stock: 7 }),
    toolCall('inventory-2', 'inventory', { sku: 'A' }, 'success', { stock: 7 }),
    toolCall('inventory-3', 'inventory', { sku: 'A' }, 'success', { stock: 7 }),
  ]);
  let seenUser = '';
  let seenRequest: JudgeLlmRequest | null = null;
  setJudgeLlmCallerForTest(async (user, request) => {
    seenUser = user;
    seenRequest = request;
    return JSON.stringify(buildJudgment('step-efficiency'));
  });

  const output = await runAgentTrajectoryPreset('preset-agent-step-efficiency', 'boundary-user', context(task, interactions));
  const request = seenRequest as JudgeLlmRequest | null;
  assert.ok(request);
  const envelope = JSON.parse(request.user) as PromptEnvelope;
  assert.equal(seenUser, 'boundary-user');
  assert.equal(
    (request as JudgeLlmRequest & { samplingProfile?: string }).samplingProfile,
    'canonical-trajectory',
  );
  assert.equal(envelope.task, task);
  assert.ok(envelope.trajectoryFacts.steps.length >= 3);
  assert.match(JSON.stringify(envelope.trajectoryFacts.steps), /开始执行/);
  assert.match(JSON.stringify(envelope.trajectoryFacts.steps), /\\"sku\\":\\"A\\"/);
  assert.match(JSON.stringify(envelope.trajectoryFacts.steps), /\\"stock\\":7/);
  assert.deepEqual(envelope.trajectoryFacts.candidates.repeatedSameResultCandidates[0].stepIndexes, [2, 3, 4]);
  assert.deepEqual(envelope.rubric.dimensions, EFFICIENCY_DIMENSIONS);
  assert.ok(envelope.rubric.issueCodes.includes('duplicate_no_gain'));
  assert.doesNotMatch(request.user, /"(?:weight|weights|cap|caps|score|scores|argsFingerprint|outputFingerprint)"/i);
  assert.doesNotMatch(
    `${request.system}\n${request.user}`,
    /(?:score|weight|cap|分数|权重|封顶)\s*(?:[:=≤<]|为)\s*\d/i,
  );
  assert.equal(output.points?.length, 5);
});

test('judge boundary: both production requests carry all hand-checked issue semantics without rule swaps', async () => {
  for (const kind of ['step-efficiency', 'process-quality'] as const) {
    let seenRequest: JudgeLlmRequest | null = null;
    setJudgeLlmCallerForTest(async (_user, request) => {
      seenRequest = request;
      return JSON.stringify(buildJudgment(kind));
    });

    await runAgentTrajectoryPreset(
      presetId(kind),
      'prompt-contract-user',
      context('直接完成任务。', messageTrace('直接完成任务。', '已完成。')),
    );

    const request = seenRequest as JudgeLlmRequest | null;
    assert.ok(request, kind);
    const envelope = JSON.parse(request.user) as PromptEnvelope;
    const rules = envelope.rubric.issueRules;
    const expectedRules = PROMPT_RULE_SEMANTICS[kind];
    assert.equal(rules.length, 8, kind);
    assert.deepEqual(
      rules.map(rule => ({ code: rule.code, dimension: rule.dimension })),
      expectedRules.map(rule => ({ code: rule.code, dimension: rule.dimension })),
      kind,
    );
    for (const [index, expected] of expectedRules.entries()) {
      const rule = rules[index];
      assert.match(rule.trigger, expected.trigger, `${kind}:${expected.code}:trigger`);
      assert.match(rule.doNotTriggerWhen, expected.doNotTriggerWhen, `${kind}:${expected.code}:doNotTriggerWhen`);
    }

    const unusedResultRule = rules.find(rule => rule.code === 'unused_tool_result_processing');
    if (kind === 'step-efficiency') {
      assert.ok(unusedResultRule);
      assert.match(unusedResultRule.doNotTriggerWhen, /正常.*一次.*不得触发/);
      assert.match(unusedResultRule.trigger, /近似复述.*不是.*状态确认/);
      assert.match(unusedResultRule.trigger, /完整列表.*自然语言包装/);
      assert.match(unusedResultRule.doNotTriggerWhen, /动作完成.*确认.*错误恢复.*不得触发/);
      assert.match(unusedResultRule.doNotTriggerWhen, /非平凡解释.*语义推导.*格式转换/);
    }
    const recoverableErrorRule = rules.find(rule => rule.code === 'unhandled_recoverable_error');
    if (kind === 'process-quality') {
      assert.ok(recoverableErrorRule);
      assert.doesNotMatch(recoverableErrorRule.trigger, /说明后终止/);
    }

    assert.doesNotMatch(request.user, /"(?:score|weight|cap)s?"\s*:/i);
  }
});

test('judge boundary: efficiency rules distinguish long detours and tool-result processing by priority', async () => {
  let seenRequest: JudgeLlmRequest | null = null;
  setJudgeLlmCallerForTest(async (_user, request) => {
    seenRequest = request;
    return JSON.stringify(buildJudgment('step-efficiency'));
  });

  await runAgentTrajectoryPreset(
    'preset-agent-step-efficiency',
    'efficiency-priority-user',
    context('直接完成任务。', messageTrace('直接完成任务。', '已完成。')),
  );

  const request = seenRequest as JudgeLlmRequest | null;
  assert.ok(request);
  const rules = (JSON.parse(request.user) as PromptEnvelope).rubric.issueRules;
  const irrelevant = rules.find(rule => rule.code === 'irrelevant_detour');
  const avoidableLlm = rules.find(rule => rule.code === 'avoidable_llm_overuse');
  const excessive = rules.find(rule => rule.code === 'excessive_detour');
  const unusedResult = rules.find(rule => rule.code === 'unused_tool_result_processing');
  assert.ok(irrelevant);
  assert.ok(avoidableLlm);
  assert.ok(excessive);
  assert.ok(unusedResult);
  assert.match(irrelevant.doNotTriggerWhen, /至少\s*3.*长路径.*excessive_detour/);
  assert.match(avoidableLlm.doNotTriggerWhen, /工具结果.*直接包含.*任务所需完整答案.*unused_tool_result_processing/);
  assert.match(excessive.trigger, /至少\s*3.*非必要.*核心动作.*长路径/);
  assert.match(excessive.doNotTriggerWhen, /少于\s*3.*irrelevant_detour/);
  assert.match(unusedResult.trigger, /完整内容.*近似复述.*优先.*avoidable_llm_overuse/);
});

test('judge boundary: information utilization compares required fields, tool facts, and final answer before met', async () => {
  let seenRequest: JudgeLlmRequest | null = null;
  setJudgeLlmCallerForTest(async (_user, request) => {
    seenRequest = request;
    return JSON.stringify(buildJudgment('process-quality'));
  });

  await runAgentTrajectoryPreset(
    'preset-agent-process-quality',
    'information-comparison-user',
    context('直接完成任务。', messageTrace('直接完成任务。', '已完成。')),
  );

  const request = seenRequest as JudgeLlmRequest | null;
  assert.ok(request);
  const rubric = (JSON.parse(request.user) as PromptEnvelope).rubric;
  const dimension = rubric.dimensionRules.find(rule => rule.dimension === 'information_utilization');
  const contradicted = rubric.issueRules.find(rule => rule.code === 'contradicted_tool_result');
  const unusedRequired = rubric.issueRules.find(rule => rule.code === 'unused_required_information');
  assert.ok(dimension);
  assert.ok(contradicted);
  assert.ok(unusedRequired);
  assert.match(dimension.definition, /逐项比较.*任务要求.*工具返回.*最终答案/);
  assert.match(contradicted.trigger, /逐项比较.*关键事实.*直接冲突.*必须触发/);
  assert.match(contradicted.trigger, /数值\s*0.*存在.*可用.*充足.*false.*肯定结论/);
  assert.match(unusedRequired.trigger, /逐项比较.*必要字段.*最终.*遗漏.*必须触发/);
});

test('judge boundary: unused required information requires observable tool fields, not task-only context', async () => {
  let seenRequest: JudgeLlmRequest | null = null;
  setJudgeLlmCallerForTest(async (_user, request) => {
    seenRequest = request;
    return JSON.stringify(buildJudgment('process-quality'));
  });

  await runAgentTrajectoryPreset(
    'preset-agent-process-quality',
    'unused-information-counterexample-user',
    context(
      '返回项目代号。',
      messageTrace('返回项目代号。', '普通上下文只提到存在项目代号字段。', '无法从当前信息给出代号。'),
    ),
  );

  const request = seenRequest as JudgeLlmRequest | null;
  assert.ok(request);
  const envelope = JSON.parse(request.user) as PromptEnvelope;
  assert.equal(envelope.trajectoryFacts.steps.some(step => step.kind === 'tool'), false);
  const issueRule = envelope.rubric.issueRules.find(rule => rule.code === 'unused_required_information');
  assert.ok(issueRule);
  assert.match(issueRule.trigger, /可观察工具结果.*明确返回.*任务要求.*必要字段.*最终.*遗漏/);
  assert.doesNotMatch(issueRule.trigger, /上下文/);
  assert.match(issueRule.doNotTriggerWhen, /仅有任务文本.*普通上下文.*没有.*工具返回.*不得触发/);
  const dimensionRule = envelope.rubric.dimensionRules.find(rule => rule.dimension === 'information_utilization');
  assert.ok(dimensionRule);
  assert.ok(dimensionRule.exclusions.some(exclusion => (
    /unused_required_information.*可观察工具结果.*必要字段/.test(exclusion)
  )));
  assert.ok(dimensionRule.exclusions.some(exclusion => (
    /任务文本.*普通上下文.*没有.*工具返回.*不得触发/.test(exclusion)
  )));
});

test('judge boundary: both production requests carry hand-checked dimension definitions and exclusions', async () => {
  for (const kind of ['step-efficiency', 'process-quality'] as const) {
    let seenRequest: JudgeLlmRequest | null = null;
    setJudgeLlmCallerForTest(async (_user, request) => {
      seenRequest = request;
      return JSON.stringify(buildJudgment(kind));
    });

    await runAgentTrajectoryPreset(
      presetId(kind),
      'dimension-contract-user',
      context('直接完成任务。', messageTrace('直接完成任务。', '已完成。')),
    );

    const request = seenRequest as JudgeLlmRequest | null;
    assert.ok(request, kind);
    const rules = (JSON.parse(request.user) as PromptEnvelope).rubric.dimensionRules;
    const expectedRules = DIMENSION_RULE_SEMANTICS[kind];
    assert.equal(rules.length, expectedRules.length, kind);
    assert.deepEqual(
      rules.map(rule => ({ dimension: rule.dimension, allowedIssueCodes: rule.allowedIssueCodes })),
      expectedRules.map(rule => ({ dimension: rule.dimension, allowedIssueCodes: rule.allowedIssueCodes })),
      kind,
    );
    for (const [index, expected] of expectedRules.entries()) {
      const rule = rules[index];
      assert.match(rule.definition, expected.definition, `${kind}:${expected.dimension}:definition`);
      assert.equal(rule.exclusions.length, expected.exclusions.length, `${kind}:${expected.dimension}:exclusions`);
      for (const exclusion of expected.exclusions) {
        assert.ok(
          rule.exclusions.some(actual => exclusion.test(actual)),
          `${kind}:${expected.dimension}:${exclusion}`,
        );
      }
    }
    assert.doesNotMatch(request.user, /"(?:score|weight|cap)s?"\s*:/i);
  }
});

test('judge boundary: both production requests carry complete mechanical grounding rules', async () => {
  for (const kind of ['step-efficiency', 'process-quality'] as const) {
    let seenRequest: JudgeLlmRequest | null = null;
    setJudgeLlmCallerForTest(async (_user, request) => {
      seenRequest = request;
      return JSON.stringify(buildJudgment(kind));
    });

    await runAgentTrajectoryPreset(
      presetId(kind),
      'prompt-mechanics-user',
      context('直接完成任务。', messageTrace('直接完成任务。', '已完成。')),
    );

    const request = seenRequest as JudgeLlmRequest | null;
    assert.ok(request, kind);
    const mechanics = (JSON.parse(request.user) as PromptEnvelope).rubric.mechanicalRules;
    assert.match(mechanics.stepIndexes.join('\n'), /存在.*index/);
    assert.match(mechanics.stepIndexes.join('\n'), /非空.*去重/);
    assert.match(mechanics.stepIndexes.join('\n'), /支持.*问题.*最小/);
    assert.deepEqual(Object.keys(mechanics.candidateRequirements).sort(), [
      'duplicate_no_gain',
      'fragmented_mergeable_steps',
      'unchanged_retry_loop',
      'unused_tool_result_processing',
    ]);
    assert.match(JSON.stringify(mechanics.candidateRequirements), /完全一致/);
    const unusedToolResultRequirement = mechanics.candidateRequirements.unused_tool_result_processing;
    assert.match(unusedToolResultRequirement, /至少包含\s*3\s*个索引/);
    assert.match(unusedToolResultRequirement, /非失败工具步骤.*真正根级终态回答/);
    assert.match(unusedToolResultRequirement, /普通必要回答不得触发/);
    assert.match(unusedToolResultRequirement, /完整列表.*自然语言包装.*近似复述/);
    assert.match(mechanics.toolName.join('\n'), /所有.*具名工具步骤.*完全一致/);
    assert.match(mechanics.toolName.join('\n'), /toolName 是可选证据字段/);
    assert.match(mechanics.toolName.join('\n'), /省略.*空字符串.*null/);
    assert.match(mechanics.verdictIssueConsistency.join('\n'), /partial.*missing.*同一维度.*ground/i);
    assert.match(mechanics.verdictIssueConsistency.join('\n'), /met.*不得/);
    assert.match(mechanics.evaluationOrder.join('\n'), /先.*grounded issues.*再.*dimensions/i);
    assert.match(mechanics.evaluationOrder.join('\n'), /没有.*同维.*合法.*issue.*met/i);
    assert.match(mechanics.evaluationOrder.join('\n'), /一般负面后果.*不得.*跨维/);
    assert.match(mechanics.evaluationOrder.join('\n'), /duplicate_no_gain.*优先/);
    assert.match(mechanics.evaluationOrder.join('\n'), /excessive_detour.*优先.*irrelevant_detour/);
    assert.match(mechanics.evaluationOrder.join('\n'), /excessive_detour.*优先.*fragmented_mergeable_steps/);
    assert.match(mechanics.stringFields.join('\n'), /reason.*非空/);
    assert.match(mechanics.stringFields.join('\n'), /met.*suggestion.*空字符串/);
    assert.match(mechanics.stringFields.join('\n'), /partial.*missing.*suggestion.*非空/);
    const serializedMechanics = JSON.stringify(mechanics);
    assert.doesNotMatch(serializedMechanics, /legacyCompatibility|keyActions/);
  }
});

test('judge boundary: quality prompt requires an explicit plan-switch count before path robustness verdict', async () => {
  let seenRequest: JudgeLlmRequest | null = null;
  setJudgeLlmCallerForTest(async (_user, request) => {
    seenRequest = request;
    return JSON.stringify(buildJudgment('process-quality'));
  });

  await runAgentTrajectoryPreset(
    'preset-agent-process-quality',
    'path-robustness-prompt-user',
    context(
      '处理数据并保持方案稳定。',
      messageTrace('处理数据并保持方案稳定。', '无新证据从 Python 切换到 Shell。', '无新证据又切回 Python。'),
    ),
  );

  const request = seenRequest as JudgeLlmRequest | null;
  assert.ok(request);
  assert.match(request.system, /path_robustness.*按.*step.*顺序.*方案.*切换次数/i);
  assert.match(request.system, /至少\s*2\s*次.*没有新证据.*decision_thrashing/i);
  assert.match(request.system, /不同工具.*无关步骤.*目标.*偏移.*不等于.*方案切换/i);
});

test('process quality rubric treats sustained unrelated scope expansion as goal drift even when the final target succeeds', () => {
  const prompt = buildAgentProcessQualityPrompt({
    task: '查找项目预算。',
    trajectoryFacts: { steps: [] },
  });
  const envelope = JSON.parse(prompt.user) as {
    rubric: {
      issueRules: Array<{ code: string; trigger: string; doNotTriggerWhen: string }>;
    };
  };
  const rule = envelope.rubric.issueRules.find(item => item.code === 'goal_drift');

  assert.ok(rule);
  assert.match(rule.trigger, /多个[^。]*无关[^。]*扩大任务范围/);
  assert.match(rule.doNotTriggerWhen, /最终完成原目标[^。]*不能抵消/);
});

test('judge boundary: 81+ visible steps pass through the canonical judge request without trace summarization', async () => {
  const task = '逐步核对长轨迹。';
  const interactions = messageTrace(task, ...Array.from({ length: 81 }, (_, index) => `可见步骤 ${index}`));
  let promptStepCount = 0;
  setJudgeLlmCallerForTest(async (_user, request) => {
    promptStepCount = (JSON.parse(request.user) as PromptEnvelope).trajectoryFacts.steps.length;
    return JSON.stringify(buildJudgment('step-efficiency'));
  });

  await runAgentTrajectoryPreset('preset-agent-step-efficiency', 'long-trace-user', context(task, interactions));
  assert.ok(promptStepCount >= 82, `expected all 82+ visible steps, got ${promptStepCount}`);
});

test('judge boundary: two malformed JSON responses become a non-retryable exhausted error', async () => {
  setJudgeLlmCallerForTest(async () => 'not-json');
  await assert.rejects(
    () => runAgentTrajectoryPreset(
      'preset-agent-step-efficiency',
      'invalid-json-user',
      context('直接回答。', messageTrace('直接回答。', '答案。')),
    ),
    AgentTrajectoryContractExhaustedError,
  );
});

test('judge boundary: full request rejects task text that pushes system plus user over 120000 chars', async () => {
  let judgeCalled = false;
  await assert.rejects(
    () => runAgentTrajectoryJudge({
      kind: 'step-efficiency',
      task: 'T'.repeat(120_000),
      interactions: messageTrace('短任务。', '短回答。'),
    }, async () => {
      judgeCalled = true;
      return JSON.stringify(buildJudgment('step-efficiency'));
    }, buildAgentStepEfficiencyPrompt),
    TrajectoryPromptTooLargeError,
  );
  assert.equal(judgeCalled, false);
});

test('judge boundary: full request rejects task text that pushes system plus user over 120000 chars', async () => {
  let judgeCalled = false;
  await assert.rejects(
    () => runAgentTrajectoryJudge({
      kind: 'process-quality',
      task: `执行关键动作。${'R'.repeat(120_000)}`,
      interactions: messageTrace('执行关键动作。', '动作已执行。'),
    }, async () => {
      judgeCalled = true;
      return JSON.stringify(buildJudgment('process-quality'));
    }, buildAgentProcessQualityPrompt),
    TrajectoryPromptTooLargeError,
  );
  assert.equal(judgeCalled, false);
});

test('judge boundary: facts below their own limit still fail when request overhead crosses 120000 chars', async () => {
  const interactions = messageTrace(
    '短任务。',
    ...Array.from({ length: 180 }, (_, index) => `${index}:${'x'.repeat(500)}`),
  );
  const factsPayload = promptAgentTrajectoryFacts(extractAgentTrajectoryFacts(interactions));
  const factsChars = JSON.stringify(factsPayload).length;
  assert.ok(factsChars < 120_000);
  const task = 'T'.repeat(Math.max(1, 120_000 - factsChars));
  let judgeCalled = false;
  await assert.rejects(
    () => runAgentTrajectoryJudge({ kind: 'step-efficiency', task, interactions }, async () => {
      judgeCalled = true;
      return JSON.stringify(buildJudgment('step-efficiency'));
    }, buildAgentStepEfficiencyPrompt),
    TrajectoryPromptTooLargeError,
  );
  assert.equal(judgeCalled, false);
});

test('judge boundary: exactly 120000 system plus user chars is accepted', async () => {
  const interactions = messageTrace('短任务。', '短回答。');
  const trajectoryFacts = promptAgentTrajectoryFacts(extractAgentTrajectoryFacts(interactions));
  const emptyTaskPrompt = buildAgentStepEfficiencyPrompt({ task: '', trajectoryFacts });
  const task = 'T'.repeat(120_000 - emptyTaskPrompt.system.length - emptyTaskPrompt.user.length);
  let judgeCalled = false;
  const output = await runAgentTrajectoryJudge({ kind: 'step-efficiency', task, interactions }, async () => {
    judgeCalled = true;
    return JSON.stringify(buildJudgment('step-efficiency'));
  }, buildAgentStepEfficiencyPrompt);
  assert.equal(judgeCalled, true);
  assert.equal(output.score, 100);
});

test('judge grounding: removing the repeated-result fact rejects a deterministic duplicate issue', async () => {
  const issue: ScenarioIssue = {
    code: 'duplicate_no_gain',
    dimension: 'step_necessity',
    stepIndexes: [2, 3, 4],
    toolName: 'search',
  };
  setJudgeLlmCallerForTest(async () => JSON.stringify(buildJudgment('step-efficiency', issue)));
  const repeated = toolTrace('搜索。', [
    toolCall('same-1', 'search', { q: 'x' }, 'success', { value: 1 }),
    toolCall('same-2', 'search', { q: 'x' }, 'success', { value: 1 }),
    toolCall('same-3', 'search', { q: 'x' }, 'success', { value: 1 }),
  ]);
  const grounded = await runAgentTrajectoryPreset(
    'preset-agent-step-efficiency',
    'grounding-user',
    context('搜索。', repeated),
  );
  assert.equal(grounded.score, 50);

  const withoutRepeatedResult = toolTrace('搜索。', [
    toolCall('changed-1', 'search', { q: 'x' }, 'success', { value: 1 }),
    toolCall('changed-2', 'search', { q: 'x' }, 'success', { value: 2 }),
    toolCall('changed-3', 'search', { q: 'x' }, 'success', { value: 3 }),
  ]);
  await assert.rejects(
    () => runAgentTrajectoryPreset(
      'preset-agent-step-efficiency',
      'grounding-user',
      context('搜索。', withoutRepeatedResult),
    ),
    AgentTrajectoryContractExhaustedError,
  );
});

const efficiencyScenarios: Scenario[] = [
  {
    number: 1, title: '单步直接查询', task: '查询 2024 年销售额，并将工具返回的元换算为万元回答。',
    interactions: toolTrace('查询 2024 年销售额，并将工具返回的元换算为万元回答。', [toolCall('q1', 'query_sales', { year: '2024' }, 'success', { salesYuan: 1200000 })], '2024 年销售额为 120 万元。'), total: 100,
    ...issuePolicy('step-efficiency'),
  },
  {
    number: 2, title: '重复调用没有信息增量', task: '查找项目 A 的负责人。',
    interactions: toolTrace('查找项目 A 的负责人。', [
      toolCall('s1', 'search_contact', { project: '项目 A' }, 'success', { owner: '张三' }),
      toolCall('s2', 'search_contact', { project: '项目 A' }, 'success', { owner: '张三' }),
      toolCall('s3', 'search_contact', { project: '项目 A' }, 'success', { owner: '张三' }),
    ]),
    issue: { code: 'duplicate_no_gain', dimension: 'step_necessity', candidateKey: 'repeatedSameResultCandidates', toolName: 'search_contact' },
    totalMax: 50, dimension: 'step_necessity', dimensionMax: 40,
    ...issuePolicy('step-efficiency', 'duplicate_no_gain'),
  },
  {
    number: 3, title: '无关探索形成绕路', task: '发送邮件给张三。',
    interactions: toolTrace('发送邮件给张三。', [
      toolCall('w1', 'unrelated_lookup', { topic: '北京天气' }, 'success', { weather: '晴' }),
      toolCall('n1', 'unrelated_lookup', { topic: '今日新闻' }, 'success', { headlines: ['新闻一'] }),
      toolCall('m1', 'send_email', { to: '张三', subject: '通知', body: '你好' }, 'success', { sent: true }),
    ], '绕路后才完成邮件发送。'),
    issue: { code: 'irrelevant_detour', dimension: 'path_detour', stepIndexes: [2, 3], toolName: 'unrelated_lookup' },
    totalMax: 40, dimension: 'path_detour', dimensionMax: 30,
    ...issuePolicy('step-efficiency', 'irrelevant_detour'),
  },
  {
    number: 4, title: '同参失败原地重试', task: '查询数据库并在超时后恢复。',
    interactions: toolTrace('查询数据库并在超时后恢复。', [
      toolCall('r1', 'query_database', { sql: 'SELECT status FROM jobs WHERE id = 7' }, 'timeout', { error: 'timeout' }),
      toolCall('r2', 'query_database', { sql: 'SELECT status FROM jobs WHERE id = 7' }, 'timeout', { error: 'timeout' }),
      toolCall('r3', 'query_database', { sql: 'SELECT status FROM jobs WHERE id = 7' }, 'timeout', { error: 'timeout' }),
      toolCall('r4', 'query_database', { sql: 'SELECT status FROM jobs WHERE id = 7' }, 'timeout', { error: 'timeout' }),
      toolCall('r5', 'query_database', { sql: 'SELECT status FROM jobs WHERE id = 7' }, 'timeout', { error: 'timeout' }),
      toolCall('r6', 'query_database_replica', { sql: 'SELECT status FROM jobs WHERE id = 7' }, 'success', { status: 'running' }),
    ], '任务已恢复，查询到的当前状态为 running。'),
    issue: { code: 'unchanged_retry_loop', dimension: 'retry_efficiency', candidateKey: 'unchangedRetryCandidates', toolName: 'query_database' },
    totalMax: 40, dimension: 'retry_efficiency', dimensionMax: 20,
    ...issuePolicy('step-efficiency', 'unchanged_retry_loop'),
  },
  {
    number: 5, title: '可避免的 LLM 过度调用', task: '拼接两个已知字符串“open”和“Euler”。',
    interactions: messageTrace(
      '拼接两个已知字符串“open”和“Euler”。',
      'LLM 第 1 步：已得到确定结果 openEuler，但暂不回答。',
      'LLM 第 2 步：再次调用 LLM 复述同一确定结果并最终回答 openEuler。',
    ),
    issue: { code: 'avoidable_llm_overuse', dimension: 'cost_efficiency', stepIndexes: [1, 2] },
    totalMax: 50, dimension: 'cost_efficiency', dimensionMax: 30,
    ...issuePolicy('step-efficiency', 'avoidable_llm_overuse'),
  },
  {
    number: 6, title: '可合并步骤被碎片化', task: 'read_file 支持 paths 数组批量读取。请读取三个配置文件。',
    interactions: toolTrace('read_file 支持 paths 数组批量读取。请读取三个配置文件。', [
      toolCall('f1', 'read_file', { path: '/etc/app.yaml' }, 'success', { content: 'app' }),
      toolCall('f2', 'read_file', { path: '/etc/db.yaml' }, 'success', { content: 'db' }),
      toolCall('f3', 'read_file', { path: '/etc/cache.yaml' }, 'success', { content: 'cache' }),
    ]),
    issue: { code: 'fragmented_mergeable_steps', dimension: 'step_density', candidateKey: 'consecutiveSimilarCandidates', toolName: 'read_file' },
    totalMax: 60, dimension: 'step_density', dimensionMax: 50,
    ...issuePolicy('step-efficiency', 'fragmented_mergeable_steps'),
  },
  {
    number: 7, title: '参数错误后立即修正', task: '使用 API 查询项目 A。',
    interactions: sequentialToolTrace('使用 API 查询项目 A。', [
      toolCall('c1', 'query_project_api', { project: '' }, 'error', { error: 'project required' }),
      toolCall('c2', 'query_project_api', { project: 'A' }, 'success', { status: 'active' }),
    ]), totalMin: 80, dimension: 'retry_efficiency', dimensionMin: 80,
    ...issuePolicy('step-efficiency'),
  },
  {
    number: 8, title: '核心动作前存在长路径偏航', task: '无需任何前置探索；translate_and_reply 已配置且会直接回复用户。请立即用它把 hello 翻译为中文并回复。',
    interactions: toolTrace('无需任何前置探索；translate_and_reply 已配置且会直接回复用户。请立即用它把 hello 翻译为中文并回复。', [
      toolCall('d1', 'inspect_translation_support', { mode: 'docs' }, 'success', { pages: ['overview'] }),
      toolCall('d2', 'inspect_translation_support', { mode: 'language_detection' }, 'success', { language: 'en' }),
      toolCall('d3', 'inspect_translation_support', { mode: 'example' }, 'success', { translation: '早上好' }),
      toolCall('d4', 'translate_and_reply', { text: 'hello', target: 'zh' }, 'success', { delivered: true }),
    ], '已通过 translate_and_reply 将翻译结果直接回复给用户。'),
    issue: { code: 'excessive_detour', dimension: 'path_detour', stepIndexes: [2, 3, 4], toolName: 'inspect_translation_support' },
    totalMax: 30, dimension: 'path_detour', dimensionMax: 20,
    extraDimension: 'step_necessity', extraDimensionMax: 30,
    ...issuePolicy('step-efficiency', 'excessive_detour'),
  },
  {
    number: 9, title: '工具答案已足够仍继续加工', task: '说明 /workspace 目录下有什么。',
    interactions: [
      { role: 'user', content: '说明 /workspace 目录下有什么。' },
      { role: 'assistant', content: '读取目录。', tool_calls: [toolCall('i1', 'list_files', { path: '/workspace' }, 'success', { files: ['README.md', 'src', 'package.json'] })] },
      { role: 'assistant', content: '我先整理工具返回的目录项。' },
      { role: 'assistant', content: '调用 LLM 仅复述工具列表：目录下有 README.md、src 和 package.json。' },
    ],
    issue: { code: 'unused_tool_result_processing', dimension: 'cost_efficiency', stepIndexes: [2, 3, 4], toolName: 'list_files' },
    totalMax: 50, dimension: 'cost_efficiency', dimensionMax: 30,
    ...issuePolicy('step-efficiency', 'unused_tool_result_processing'),
  },
  {
    number: 10, title: '简单算术直接回答', task: '2+2 等于多少？',
    interactions: messageTrace('2+2 等于多少？', '4'), total: 100,
    ...issuePolicy('step-efficiency'),
  },
  {
    number: 11, title: '必要依赖多步链', task: '查询订单状态，已发货则查询物流并通知用户。',
    interactions: sequentialToolTrace('查询订单状态，已发货则查询物流并通知用户。', [
      toolCall('m1', 'get_order_status', { orderId: 'O-1' }, 'success', { status: 'shipped' }),
      toolCall('m2', 'query_logistics', { orderId: 'O-1' }, 'success', { tracking: 'SF123' }),
      toolCall('m3', 'send_notification', { userId: 'U-1', message: '订单已发货，物流单号 SF123' }, 'success', { sent: true }),
    ], '订单已发货，已查询物流并通知用户。'), totalMin: 90,
    ...issuePolicy('step-efficiency'),
  },
  {
    number: 12, title: '局部失败后过度回滚', task: '完成两步部署流程；若步骤 2 临时失败且前序状态仍有效，只重试步骤 2。',
    interactions: sequentialToolTrace('完成两步部署流程；若步骤 2 临时失败且前序状态仍有效，只重试步骤 2。', [
      toolCall('o1', 'deploy_step', { step: 1, attempt: 1 }, 'success', { completed: true, step: 1, attempt: 1 }),
      toolCall('o2', 'deploy_step', { step: 2, attempt: 1 }, 'error', { error: 'temporary failure', priorStepsRemainValid: true }),
      toolCall('o3', 'deploy_step', { step: 1, attempt: 2 }, 'success', { completed: true, step: 1, attempt: 2 }),
      toolCall('o4', 'deploy_step', { step: 2, attempt: 2 }, 'success', { completed: true, step: 2, attempt: 2 }),
    ], '步骤 2 临时失败且步骤 1 仍有效，却回退并重做了步骤 1。'),
    issue: { code: 'overrollback', dimension: 'retry_efficiency', stepIndexes: [2, 4, 6, 8], toolName: 'deploy_step' },
    totalMax: 40, dimension: 'retry_efficiency', dimensionMax: 20,
    ...issuePolicy('step-efficiency', 'overrollback'),
  },
];

for (const scenario of efficiencyScenarios) {
  test(`efficiency ${scenario.number}: ${scenario.title}`, async () => {
    const output = await runScenario('step-efficiency', scenario);
    assert.equal(output.points?.length, 5);
    if (scenario.total !== undefined) assert.equal(output.score, scenario.total);
    if (scenario.totalMin !== undefined) assert.ok((output.score ?? -1) >= scenario.totalMin);
    if (scenario.totalMax !== undefined) assert.ok((output.score ?? 101) <= scenario.totalMax);
    if (scenario.dimension && scenario.dimensionMin !== undefined) {
      assert.ok((pointScore(output, scenario.dimension) ?? -1) >= scenario.dimensionMin);
    }
    if (scenario.dimension && scenario.dimensionMax !== undefined) {
      assert.ok((pointScore(output, scenario.dimension) ?? 101) <= scenario.dimensionMax);
    }
    if (scenario.extraDimension && scenario.extraDimensionMax !== undefined) {
      assert.ok((pointScore(output, scenario.extraDimension) ?? 101) <= scenario.extraDimensionMax);
    }
    assertScenarioIssuePolicy('step-efficiency', scenario, output);
  });
}

const qualityScenarios: Scenario[] = [
  {
    number: 1, title: '天气查询后给出带伞提醒', task: '查询天气并提醒是否带伞。',
    interactions: toolTrace('查询天气并提醒是否带伞。', [toolCall('w1', 'weather', { city: '北京' }, 'success', { rain: true })], '今天有雨，记得带伞。'),
    totalMin: 95,
    ...issuePolicy('process-quality'),
  },
  {
    number: 2, title: '执行目标持续漂移', task: '查找项目 A 的预算。',
    interactions: toolTrace('查找项目 A 的预算。', [
      toolCall('g1', 'query_technical_plan', { project: 'A' }, 'success', { architecture: '微服务' }),
      toolCall('g2', 'query_team_members', { project: 'A' }, 'success', { members: ['张三', '李四'] }),
      toolCall('g3', 'query_timeline', { project: 'A' }, 'success', { deadline: '2026-12-31' }),
      toolCall('g4', 'query_budget', { project: 'A' }, 'success', { budget: 1000000 }),
    ], '绕路查询技术方案、团队成员和时间线后，最终返回预算 100 万元。'),
    issue: { code: 'goal_drift', dimension: 'goal_alignment', stepIndexes: [2, 3, 4] },
    totalMax: 50, dimension: 'goal_alignment', dimensionMax: 40,
    ...issuePolicy('process-quality', 'goal_drift'),
  },
  {
    number: 3, title: '遗漏结果成立所需验证', task: '部署服务并验证健康状态。',
    interactions: messageTrace('部署服务并验证健康状态。', '部署命令成功。', '直接宣布完成，没有健康检查。'),
    issue: { code: 'missing_required_step', dimension: 'planning_completeness', stepIndexes: [2] },
    totalMax: 50, dimension: 'planning_completeness', dimensionMax: 30,
    ...issuePolicy('process-quality', 'missing_required_step'),
    allowedIssueCodes: ['missing_required_step', 'unsupported_reasoning_jump'],
    forbiddenIssueCodes: ['goal_drift', 'unhandled_recoverable_error', 'contradicted_tool_result', 'decision_thrashing', 'internal_contradiction', 'unused_required_information'],
  },
  {
    number: 4, title: '关键决策缺少可观察依据', task: '目标始终是解决登录慢；依据可观察指标选择下一步，不得改变目标。',
    interactions: messageTrace('目标始终是解决登录慢；依据可观察指标选择下一步，不得改变目标。', '目标仍是解决登录慢，没有检查任何指标就直接决定扩容数据库。'),
    issue: { code: 'unsupported_reasoning_jump', dimension: 'reasoning_coherence', stepIndexes: [1] },
    totalMax: 50, dimension: 'reasoning_coherence', dimensionMax: 40,
    ...issuePolicy('process-quality', 'unsupported_reasoning_jump'),
    allowedIssueCodes: ['missing_required_step', 'unsupported_reasoning_jump'],
    forbiddenIssueCodes: ['goal_drift', 'unhandled_recoverable_error', 'contradicted_tool_result', 'decision_thrashing', 'internal_contradiction', 'unused_required_information'],
  },
  {
    number: 5, title: '可恢复错误未处理', task: '查询数据库并在连接失败时恢复。',
    interactions: toolTrace('查询数据库并在连接失败时恢复。', [toolCall('e1', 'query_database', { sql: 'SELECT 1' }, 'error', { error: 'connection failed' })], '系统出错无法完成。'),
    issue: { code: 'unhandled_recoverable_error', dimension: 'exception_handling', stepIndexes: [2, 3], toolName: 'query_database' },
    totalMax: 40, dimension: 'exception_handling', dimensionMax: 30,
    ...issuePolicy('process-quality', 'unhandled_recoverable_error'),
    allowedIssueCodes: ['missing_required_step', 'unhandled_recoverable_error'],
    forbiddenIssueCodes: ['goal_drift', 'unsupported_reasoning_jump', 'contradicted_tool_result', 'decision_thrashing', 'internal_contradiction', 'unused_required_information'],
  },
  {
    number: 6, title: '结论与工具事实冲突', task: '查询产品规格并准确回答。',
    interactions: toolTrace('查询产品规格并准确回答。', [toolCall('k1', 'search_knowledge', { product: 'X' }, 'success', { memory: '16GB', weight: '1.2kg' })], '产品 X 配备 8GB 内存，重量 2.0kg。'),
    issue: { code: 'contradicted_tool_result', dimension: 'information_utilization', stepIndexes: [2, 3], toolName: 'search_knowledge' },
    totalMax: 50, dimension: 'information_utilization', dimensionMax: 30,
    ...issuePolicy('process-quality', 'contradicted_tool_result'),
  },
  {
    number: 7, title: '没有新证据却反复换方案', task: '处理一批数据并保持方案稳定。',
    interactions: messageTrace(
      '处理一批数据并保持方案稳定。',
      '决定使用 Python 脚本处理数据。',
      '已经写完 Python 脚本的一部分。',
      '没有新证据，第一次切换为 Shell 命令。',
      'Shell 命令执行到一半。',
      '没有新证据，第二次切换回 Python。',
      '继续写 Python 后又无依据第三次切换为 Shell。',
    ),
    issue: { code: 'decision_thrashing', dimension: 'path_robustness', stepIndexes: [1, 3, 5, 6] },
    totalMax: 40, dimension: 'path_robustness', dimensionMax: 30,
    ...issuePolicy('process-quality', 'decision_thrashing'),
    allowedIssueCodes: ['missing_required_step', 'unsupported_reasoning_jump', 'decision_thrashing'],
    forbiddenIssueCodes: ['goal_drift', 'unhandled_recoverable_error', 'contradicted_tool_result', 'internal_contradiction', 'unused_required_information'],
  },
  {
    number: 8, title: '对关键事实前后自相矛盾', task: '判断数据库是否在线。',
    interactions: messageTrace('判断数据库是否在线。', '数据库离线。', '没有新证据又称数据库在线。'),
    issue: { code: 'internal_contradiction', dimension: 'reasoning_coherence', stepIndexes: [1, 2] },
    totalMax: 40, dimension: 'reasoning_coherence', dimensionMax: 30,
    ...issuePolicy('process-quality', 'internal_contradiction'),
    allowedIssueCodes: ['missing_required_step', 'unsupported_reasoning_jump', 'internal_contradiction'],
    forbiddenIssueCodes: ['goal_drift', 'unhandled_recoverable_error', 'contradicted_tool_result', 'decision_thrashing', 'unused_required_information'],
  },
  {
    number: 9, title: '无需工具的事实直接回答', task: '北京人口约多少？',
    interactions: messageTrace('北京人口约多少？', '约 2188 万。'), total: 100,
    ...issuePolicy('process-quality'),
  },
  {
    number: 10, title: '完整的 503 排障链', task: '排查线上服务 503 错误。',
    interactions: sequentialToolTrace('排查线上服务 503 错误。', [
      toolCall('d1', 'inspect_logs', {}, 'success', { httpStatus: 503, error: 'OOM killed' }),
      toolCall('d2', 'check_memory_config', { service: 'api' }, 'success', { limit: '512Mi', peak: '510Mi' }),
      toolCall('d3', 'analyze_heap_dump', { service: 'api' }, 'success', { retainedObject: 'SessionCache', growth: 'unbounded' }),
      toolCall('d4', 'locate_memory_leak', { component: 'SessionCache' }, 'success', { rootCause: 'expired sessions not released' }),
      toolCall('d5', 'propose_fix', { component: 'SessionCache' }, 'success', { fix: 'release expired sessions and add bounds' }),
    ], '日志显示 OOM，结合内存配置和堆转储定位到 SessionCache 泄漏，并提出释放过期会话和增加边界的修复方案。'), totalMin: 85, allDimensionsMin: 80,
    ...issuePolicy('process-quality'),
  },
  {
    number: 11, title: '遗漏工具返回的必要字段', task: '返回用户的姓名、部门和职位。',
    interactions: toolTrace('返回用户的姓名、部门和职位。', [toolCall('a1', 'get_user_info', { userId: 'U-1' }, 'success', { name: '张三', department: '研发部', title: '工程师' })], '用户姓名是张三。'),
    issue: { code: 'unused_required_information', dimension: 'information_utilization', stepIndexes: [2, 3], toolName: 'get_user_info' },
    totalMax: 60, dimension: 'information_utilization', dimensionMax: 50,
    ...issuePolicy('process-quality', 'unused_required_information'),
  },
  {
    number: 12, title: '主源失败后有依据降级', task: '查询状态，主源不可用时使用镜像。',
    interactions: sequentialToolTrace('查询状态，主源不可用时使用镜像。', [
      toolCall('p1', 'primary', {}, 'error', { error: 'unavailable' }),
      toolCall('p2', 'mirror', {}, 'success', { status: 'ok' }),
    ], '镜像确认状态正常。'), totalMin: 80, dimension: 'exception_handling', dimensionMin: 80,
    ...issuePolicy('process-quality'),
  },
];

for (const scenario of qualityScenarios) {
  test(`quality ${scenario.number}: ${scenario.title}`, async () => {
    const output = await runScenario('process-quality', scenario);
    assert.equal(output.points?.length, 6);
    if (scenario.total !== undefined) assert.equal(output.score, scenario.total);
    if (scenario.totalMin !== undefined) assert.ok((output.score ?? -1) >= scenario.totalMin);
    if (scenario.totalMax !== undefined) assert.ok((output.score ?? 101) <= scenario.totalMax);
    if (scenario.dimension && scenario.dimensionMin !== undefined) {
      assert.ok((pointScore(output, scenario.dimension) ?? -1) >= scenario.dimensionMin);
    }
    if (scenario.dimension && scenario.dimensionMax !== undefined) {
      assert.ok((pointScore(output, scenario.dimension) ?? 101) <= scenario.dimensionMax);
    }
    if (scenario.allDimensionsMin !== undefined) {
      for (const dimension of QUALITY_DIMENSIONS) {
        assert.ok((pointScore(output, dimension) ?? -1) >= scenario.allDimensionsMin, dimension);
      }
    }
    assertScenarioIssuePolicy('process-quality', scenario, output);
  });
}

test('efficiency cross-cap: excessive detour gives step necessity issue evidence, stable anchors and suggestion', async () => {
  const scenario = efficiencyScenarios.find(item => item.number === 8)!;
  const output = await runScenario('step-efficiency', scenario);
  const necessity = pointFor(output, 'step_necessity');
  const pointEvidence = (necessity?.evidence as {
    json?: { issues?: Array<{ code?: string }> };
  } | undefined)?.json;
  assert.equal(necessity?.score, 30);
  assert.ok(pointEvidence?.issues?.some(issue => issue.code === 'excessive_detour'));
  assert.deepEqual(necessity?.anchors, ['step-2', 'step-3', 'step-4']);
  assert.match(necessity?.suggestion ?? '', /收敛执行路径/);
});

test('process quality evaluator excludes legacy Skill compatibility from prompt and output', async () => {
  let promptUser = '';
  setJudgeLlmCallerForTest(async (_user, request) => {
    promptUser = request.user;
    return JSON.stringify(buildJudgment('process-quality'));
  });
  const output = await runAgentTrajectoryPreset(
    'preset-agent-process-quality',
    'process-quality-user',
    context('直接回答。', messageTrace('直接回答。', '答案。')),
  );
  assert.equal(output.score, 100);
  assert.equal(output.points?.length, 6);
  assert.doesNotMatch(promptUser, /referenceKeyActions|legacyCompatibility|toolChoice|keyActions/);
  assert.equal('legacyCompatibility' in evidenceJson(output), false);
});
