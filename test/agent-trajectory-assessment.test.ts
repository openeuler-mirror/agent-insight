import assert from 'node:assert/strict';
import test from 'node:test';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import { buildAgentTrajectoryAssessment } from '@/lib/engine/evaluation/agent-trajectory-assessment';
import type { AgentTrajectoryFacts } from '@/lib/engine/evaluation/agent-trajectory-facts';

const efficiencyDimensions = [
  { dimension: 'step_necessity', verdict: 'met', reason: '所有步骤均有必要。', suggestion: '' },
  { dimension: 'path_detour', verdict: 'met', reason: '路径直接。', suggestion: '' },
  { dimension: 'cost_efficiency', verdict: 'met', reason: '没有可证实浪费。', suggestion: '' },
  { dimension: 'step_density', verdict: 'met', reason: '步骤粒度合理。', suggestion: '' },
  { dimension: 'retry_efficiency', verdict: 'met', reason: '没有无效重试。', suggestion: '' },
];

const qualityDimensions = [
  { dimension: 'goal_alignment', verdict: 'met', reason: '动作服务目标。', suggestion: '' },
  { dimension: 'planning_completeness', verdict: 'met', reason: '必要路径完整。', suggestion: '' },
  { dimension: 'reasoning_coherence', verdict: 'met', reason: '决策前后一致。', suggestion: '' },
  { dimension: 'exception_handling', verdict: 'met', reason: '没有待恢复错误。', suggestion: '' },
  { dimension: 'path_robustness', verdict: 'met', reason: '路径稳定。', suggestion: '' },
  { dimension: 'information_utilization', verdict: 'met', reason: '已使用可见信息。', suggestion: '' },
];

function candidate(stepIndexes: number[]): AgentTrajectoryFacts['candidates']['repeatedSameCallCandidates'][number] {
  return {
    stepIndexes,
    stepIndexChunks: [stepIndexes],
    page: 1,
    kind: 'tool',
    name: 'search',
  } satisfies AgentTrajectoryFacts['candidates']['repeatedSameCallCandidates'][number];
}

function facts(): AgentTrajectoryFacts {
  const canonicalFacts = {
    steps: [
      { index: 0, interactionIndex: 0, depth: 0, kind: 'tool', name: 'search', status: 'ok', outputSummary: '{"result":42}' },
      { index: 1, interactionIndex: 1, depth: 0, kind: 'tool', name: 'search', status: 'ok', outputSummary: '{"result":42}' },
      { index: 2, interactionIndex: 2, depth: 0, kind: 'llm', name: 'answer', status: 'ok', textSummary: '最终回答。' },
    ],
    statistics: {
      totalSteps: 3,
      agentTreeDepth: 0,
      totalLlmCalls: 1,
      totalToolCalls: 2,
      totalSkillCalls: 0,
      totalTaskCalls: 0,
      totalTokens: 0,
      callStatistics: {
        countsByKind: { user: 0, llm: 1, tool: 2, skill: 0, task: 0 },
        failureCount: 0,
        totalTokens: 0,
      },
    },
    candidates: {
      repeatedSameCallCandidates: [candidate([0, 1, 2])],
      repeatedSameResultCandidates: [candidate([0, 1, 2])],
      unchangedRetryCandidates: [candidate([0, 1])],
      consecutiveSimilarCandidates: [candidate([0, 1, 2])],
    },
  } satisfies AgentTrajectoryFacts;

  return canonicalFacts;
}

function efficiencyJudgment(overrides: Record<string, unknown> = {}) {
  return {
    summary: '轨迹直接完成任务。',
    dimensions: efficiencyDimensions,
    issues: [],
    ...overrides,
  };
}

function qualityJudgment(overrides: Record<string, unknown> = {}) {
  return {
    summary: '轨迹稳定完成任务。',
    dimensions: qualityDimensions,
    issues: [],
    ...overrides,
  };
}

test('拒绝五维缺维、重复维和额外维度', () => {
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: efficiencyDimensions.slice(0, 4),
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [...efficiencyDimensions.slice(0, 4), efficiencyDimensions[0]],
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [...efficiencyDimensions, { dimension: 'invented_dimension', verdict: 'met', reason: '无。', suggestion: '' }],
  })), JudgeOutputParseError);
});

test('拒绝六维缺维、重复维和额外维度', () => {
  assert.throws(() => buildAgentTrajectoryAssessment('process-quality', facts(), qualityJudgment({
    dimensions: qualityDimensions.slice(0, 5),
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('process-quality', facts(), qualityJudgment({
    dimensions: [...qualityDimensions.slice(0, 5), qualityDimensions[0]],
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('process-quality', facts(), qualityJudgment({
    dimensions: [...qualityDimensions, { dimension: 'invented_dimension', verdict: 'met', reason: '无。', suggestion: '' }],
  })), JudgeOutputParseError);
});

test('拒绝未知问题 code 和 code/dimension 不匹配', () => {
  const issue = {
    code: 'not_a_real_code', severity: 'major', dimension: 'step_necessity', stepIndexes: [0], toolName: 'search', reason: '原因。', suggestion: '建议。',
  };
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [{ ...efficiencyDimensions[0], verdict: 'partial', suggestion: '改进必要性。' }, ...efficiencyDimensions.slice(1)],
    issues: [issue],
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [{ ...efficiencyDimensions[0], verdict: 'partial', suggestion: '改进必要性。' }, ...efficiencyDimensions.slice(1)],
    issues: [{ ...issue, code: 'irrelevant_detour' }],
  })), JudgeOutputParseError);
});

test('拒绝 met 维度建议，以及非 met 维度缺建议或有效问题', () => {
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [{ ...efficiencyDimensions[0], suggestion: '不应建议。' }, ...efficiencyDimensions.slice(1)],
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [{ ...efficiencyDimensions[0], verdict: 'partial', suggestion: '' }, ...efficiencyDimensions.slice(1)],
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [{ ...efficiencyDimensions[0], verdict: 'missing', suggestion: '删除无效调用。' }, ...efficiencyDimensions.slice(1)],
  })), JudgeOutputParseError);
});

test('拒绝英文占位文本，要求评估摘要、原因和改进建议包含中文', () => {
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    summary: 'placeholder',
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [{ ...efficiencyDimensions[0], reason: 'placeholder' }, ...efficiencyDimensions.slice(1)],
  })), JudgeOutputParseError);
});

test('将不存在步骤、错误 tool 和未命中确定性候选的问题丢弃，并拒绝无剩余证据的非 met 维度', () => {
  const dimensions = [{ ...efficiencyDimensions[0], verdict: 'partial', suggestion: '删除无效调用。' }, ...efficiencyDimensions.slice(1)];
  const baseIssue = {
    code: 'duplicate_no_gain', severity: 'major', dimension: 'step_necessity', stepIndexes: [0, 1, 2], toolName: 'search', reason: '重复。', suggestion: '删除重复。',
  };
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions,
    issues: [{ ...baseIssue, stepIndexes: [99] }],
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions,
    issues: [{ ...baseIssue, toolName: 'made_up_tool' }],
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions,
    issues: [{ ...baseIssue, stepIndexes: [0] }],
  })), JudgeOutputParseError);
});

test('duplicate_no_gain 拒绝仅两步候选，并接受独立构造的三步候选', () => {
  const buildThresholdFacts = (stepIndexes: number[]): AgentTrajectoryFacts => ({
    ...facts(),
    steps: stepIndexes.map(index => ({
      index,
      interactionIndex: index,
      depth: 0,
      kind: 'tool' as const,
      name: 'search',
      status: 'ok' as const,
    })),
    candidates: {
      repeatedSameCallCandidates: [candidate(stepIndexes)],
      repeatedSameResultCandidates: [candidate(stepIndexes)],
      unchangedRetryCandidates: [],
      consecutiveSimilarCandidates: [],
    },
  });
  const buildJudgment = (stepIndexes: number[]) => efficiencyJudgment({
    dimensions: [
      { ...efficiencyDimensions[0], verdict: 'partial', suggestion: '复用首次结果。' },
      ...efficiencyDimensions.slice(1),
    ],
    issues: [{
      code: 'duplicate_no_gain',
      severity: 'major',
      dimension: 'step_necessity',
      stepIndexes,
      toolName: 'search',
      reason: '同参调用没有新增结果。',
      suggestion: '复用首次结果。',
    }],
  });

  assert.throws(
    () => buildAgentTrajectoryAssessment('step-efficiency', buildThresholdFacts([10, 11]), buildJudgment([10, 11])),
    JudgeOutputParseError,
  );
  const accepted = buildAgentTrajectoryAssessment(
    'step-efficiency',
    buildThresholdFacts([20, 21, 22]),
    buildJudgment([20, 21, 22]),
  );
  assert.deepEqual(accepted.issues[0]?.stepIndexes, [20, 21, 22]);
});

test('fragmented_mergeable_steps 拒绝仅两步候选，并接受独立构造的三步候选', () => {
  const buildThresholdFacts = (stepIndexes: number[]): AgentTrajectoryFacts => ({
    ...facts(),
    steps: stepIndexes.map(index => ({
      index,
      interactionIndex: index,
      depth: 0,
      kind: 'tool' as const,
      name: 'read_fields',
      status: 'ok' as const,
    })),
    candidates: {
      repeatedSameCallCandidates: [],
      repeatedSameResultCandidates: [],
      unchangedRetryCandidates: [],
      consecutiveSimilarCandidates: [
        { ...candidate(stepIndexes), name: 'read_fields' },
      ],
    },
  });
  const buildJudgment = (stepIndexes: number[]) => efficiencyJudgment({
    dimensions: [
      ...efficiencyDimensions.slice(0, 3),
      { ...efficiencyDimensions[3], verdict: 'partial', suggestion: '合并同类步骤。' },
      efficiencyDimensions[4],
    ],
    issues: [{
      code: 'fragmented_mergeable_steps',
      severity: 'major',
      dimension: 'step_density',
      stepIndexes,
      toolName: 'read_fields',
      reason: '同类独立步骤可以安全合并。',
      suggestion: '合并同类步骤。',
    }],
  });

  assert.throws(
    () => buildAgentTrajectoryAssessment('step-efficiency', buildThresholdFacts([30, 31]), buildJudgment([30, 31])),
    JudgeOutputParseError,
  );
  const accepted = buildAgentTrajectoryAssessment(
    'step-efficiency',
    buildThresholdFacts([40, 41, 42]),
    buildJudgment([40, 41, 42]),
  );
  assert.deepEqual(accepted.issues[0]?.stepIndexes, [40, 41, 42]);
});

test('以排序后的锚点去重，并让 excessive_detour 淘汰同根因 irrelevant_detour', () => {
  const dimensions = [
    efficiencyDimensions[0],
    { ...efficiencyDimensions[1], verdict: 'partial', suggestion: '缩短路径。' },
    ...efficiencyDimensions.slice(2),
  ];
  const result = buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions,
    issues: [
      { code: 'irrelevant_detour', severity: 'minor', dimension: 'path_detour', stepIndexes: [2, 1, 0], toolName: 'search', reason: '绕路。', suggestion: '直接执行。' },
      { code: 'irrelevant_detour', severity: 'minor', dimension: 'path_detour', stepIndexes: [0, 1, 2], toolName: 'search', reason: '绕路重复。', suggestion: '直接执行。' },
      { code: 'excessive_detour', severity: 'major', dimension: 'path_detour', stepIndexes: [0, 1, 2], reason: '严重绕路。', suggestion: '直接执行。' },
    ],
  }));
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'excessive_detour');
  assert.equal(result.dimensions.find(item => item.dimension === 'path_detour')?.score, 20);
  assert.equal(result.dimensions.find(item => item.dimension === 'step_necessity')?.score, 30);
  assert.equal(result.baseScore, 70);
  assert.equal(result.score, 30);
});

test('三个及以上无关偏航锚点不会被确定性规则擅自升级', () => {
  const result = buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [
      efficiencyDimensions[0],
      { ...efficiencyDimensions[1], verdict: 'partial', suggestion: '缩短路径。' },
      ...efficiencyDimensions.slice(2),
    ],
    issues: [{
      code: 'irrelevant_detour',
      severity: 'major',
      dimension: 'path_detour',
      stepIndexes: [0, 1, 2],
      toolName: 'search',
      reason: '三个无关步骤形成长路径偏航。',
      suggestion: '移除整段无关路径。',
    }],
  }));

  assert.deepEqual(result.issues.map(issue => issue.code), ['irrelevant_detour']);
  assert.equal(result.dimensions.find(item => item.dimension === 'path_detour')?.score, 30);
});

test('同一候选同时命中重复与碎片化时只保留 duplicate_no_gain', () => {
  const result = buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [
      { ...efficiencyDimensions[0], verdict: 'partial', suggestion: '删除重复步骤。' },
      ...efficiencyDimensions.slice(1),
    ],
    issues: [
      { code: 'duplicate_no_gain', severity: 'major', dimension: 'step_necessity', stepIndexes: [0, 1, 2], toolName: 'search', reason: '同参结果重复。', suggestion: '复用首次结果。' },
      { code: 'fragmented_mergeable_steps', severity: 'major', dimension: 'step_density', stepIndexes: [0, 1, 2], toolName: 'search', reason: '同类步骤碎片化。', suggestion: '合并步骤。' },
    ],
  }));

  assert.deepEqual(result.issues.map(issue => issue.code), ['duplicate_no_gain']);
  assert.equal(result.score, 50);
});

test('长路径偏航已覆盖同一候选时淘汰从属的碎片化问题', () => {
  const result = buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [
      efficiencyDimensions[0],
      { ...efficiencyDimensions[1], verdict: 'partial', suggestion: '删除整段非必要探索。' },
      ...efficiencyDimensions.slice(2),
    ],
    issues: [
      { code: 'excessive_detour', severity: 'major', dimension: 'path_detour', stepIndexes: [0, 1, 2], toolName: 'search', reason: '整段探索延后核心动作。', suggestion: '直接执行核心动作。' },
      { code: 'fragmented_mergeable_steps', severity: 'minor', dimension: 'step_density', stepIndexes: [0, 1, 2], toolName: 'search', reason: '同类探索可以合并。', suggestion: '合并探索步骤。' },
    ],
  }));

  assert.deepEqual(result.issues.map(issue => issue.code), ['excessive_detour']);
  assert.equal(result.score, 30);
});

test('按 verdict、维度封顶、等权基础分、总分封顶的固定顺序计分，且保留零分', () => {
  const dimensions = [
    { ...efficiencyDimensions[0], verdict: 'missing', suggestion: '删除重复调用。' },
    efficiencyDimensions[1],
    efficiencyDimensions[2],
    efficiencyDimensions[3],
    efficiencyDimensions[4],
  ];
  const result = buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions,
    issues: [{
      code: 'duplicate_no_gain', severity: 'critical', dimension: 'step_necessity', stepIndexes: [0, 1, 2], toolName: 'search', reason: '三次调用没有新信息。', suggestion: '复用首次结果。',
    }],
  }));
  assert.equal(result.dimensions.find(item => item.dimension === 'step_necessity')?.rawScore, 0);
  assert.equal(result.dimensions.find(item => item.dimension === 'step_necessity')?.score, 0);
  assert.equal(result.baseScore, 80);
  assert.equal(result.score, 50);
});

test('拒绝跨 rubric 的合法问题 code，避免其穿透并触发错误封顶', () => {
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    issues: [{
      code: 'goal_drift', severity: 'major', dimension: 'goal_alignment', stepIndexes: [0], toolName: 'search', reason: '目标偏离。', suggestion: '回到原始目标。',
    }],
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('process-quality', facts(), qualityJudgment({
    issues: [{
      code: 'duplicate_no_gain', severity: 'major', dimension: 'step_necessity', stepIndexes: [0, 1, 2], toolName: 'search', reason: '重复调用。', suggestion: '复用首次结果。',
    }],
  })), JudgeOutputParseError);
});

test('工具结果未使用问题必须锚定成功工具结果和真正终态回答', () => {
  const dimensions = efficiencyDimensions.map(item => (
    item.dimension === 'cost_efficiency'
      ? { ...item, verdict: 'partial' as const, suggestion: '删除无增益处理。' }
      : item
  ));
  const issue = {
    code: 'unused_tool_result_processing',
    severity: 'critical',
    dimension: 'cost_efficiency',
    reason: '工具结果已经包含答案，后续处理没有增加信息。',
    suggestion: '直接使用工具结果回答。',
  } as const;

  assert.throws(() => buildAgentTrajectoryAssessment(
    'step-efficiency',
    facts(),
    efficiencyJudgment({
      dimensions,
      issues: [{ ...issue, stepIndexes: [2] }],
    }),
  ), JudgeOutputParseError);

  const processingFacts = facts();
  processingFacts.steps = [
    { index: 0, interactionIndex: 0, depth: 0, kind: 'tool', name: 'search', status: 'ok', outputSummary: '{"result":42}' },
    { index: 1, interactionIndex: 1, depth: 0, kind: 'llm', name: 'process', status: 'ok', textSummary: '整理工具结果。' },
    { index: 2, interactionIndex: 2, depth: 0, kind: 'llm', name: 'answer', status: 'ok', textSummary: '最终回答。' },
  ];
  const directSummary = buildAgentTrajectoryAssessment(
    'step-efficiency',
    processingFacts,
    efficiencyJudgment({
      dimensions,
      issues: [{ ...issue, stepIndexes: [0, 1, 2], toolName: 'search' }],
    }),
  );
  assert.deepEqual(directSummary.issues.map(item => item.stepIndexes), [[0, 1, 2]]);

  const noTerminalAnswerFacts = facts();
  noTerminalAnswerFacts.steps[2] = {
    ...noTerminalAnswerFacts.steps[2],
    kind: 'tool',
    name: 'search',
  };
  assert.throws(() => buildAgentTrajectoryAssessment(
    'step-efficiency',
    noTerminalAnswerFacts,
    efficiencyJudgment({
      dimensions,
      issues: [{ ...issue, stepIndexes: [0, 1, 2], toolName: 'search' }],
    }),
  ), JudgeOutputParseError);

  const omittedTerminalAnswerFacts = facts();
  omittedTerminalAnswerFacts.steps.push({
    index: 3,
    interactionIndex: 3,
    depth: 0,
    kind: 'llm',
    name: 'actual-final-answer',
    status: 'ok',
  });
  assert.throws(() => buildAgentTrajectoryAssessment(
    'step-efficiency',
    omittedTerminalAnswerFacts,
    efficiencyJudgment({
      dimensions,
      issues: [{ ...issue, stepIndexes: [0, 1, 2], toolName: 'search' }],
    }),
  ), JudgeOutputParseError);

  assert.equal(directSummary.score, 50);
});

test('工具结果处理按 interactionIndex 锚定子 Agent 工具与根级终态回答', () => {
  const temporalFacts = facts();
  temporalFacts.steps = [
    { index: 2, interactionIndex: 4, depth: 0, kind: 'llm', name: 'final-answer', status: 'ok', textSummary: '最终回答是 42。' },
    { index: 3, interactionIndex: 2, depth: 1, kind: 'tool', name: 'search', status: 'ok', outputSummary: '{"answer":42}' },
    { index: 4, interactionIndex: 3, depth: 1, kind: 'llm', name: 'process', status: 'ok', textSummary: '整理子代理结果。' },
  ];
  const dimensions = efficiencyDimensions.map(item => (
    item.dimension === 'cost_efficiency'
      ? { ...item, verdict: 'partial' as const, suggestion: '直接使用工具结果。' }
      : item
  ));
  const result = buildAgentTrajectoryAssessment('step-efficiency', temporalFacts, efficiencyJudgment({
    dimensions,
    issues: [{
      code: 'unused_tool_result_processing',
      severity: 'major',
      dimension: 'cost_efficiency',
      stepIndexes: [2, 3, 4],
      toolName: 'search',
      reason: '子代理工具结果已经包含答案，根级终态回答没有增加信息。',
      suggestion: '直接使用子代理工具结果。',
    }],
  }));
  assert.deepEqual(result.issues[0]?.stepIndexes, [2, 3, 4]);
});

test('工具调用轮不能冒充真正终态文本回答', () => {
  const toolOnlyTerminalFacts = facts();
  toolOnlyTerminalFacts.steps = [
    { index: 0, interactionIndex: 1, depth: 0, kind: 'tool', name: 'search', status: 'ok', outputSummary: '{"answer":42}' },
    { index: 1, interactionIndex: 2, depth: 0, kind: 'llm', name: 'tool-call-turn', status: 'ok', textSummary: '继续调用 verify。' },
    { index: 2, interactionIndex: 2, depth: 0, kind: 'tool', name: 'verify', status: 'error', outputSummary: '{"error":"failed"}' },
  ];
  const dimensions = efficiencyDimensions.map(item => (
    item.dimension === 'cost_efficiency'
      ? { ...item, verdict: 'partial' as const, suggestion: '直接回答。' }
      : item
  ));
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', toolOnlyTerminalFacts, efficiencyJudgment({
    dimensions,
    issues: [{
      code: 'unused_tool_result_processing',
      severity: 'major',
      dimension: 'cost_efficiency',
      stepIndexes: [0, 1],
      toolName: 'search',
      reason: '错误地把工具调用轮当成最终回答。',
      suggestion: '等待真正终态文本回答。',
    }],
  })), JudgeOutputParseError);
});

test('信息利用问题接受 unknown 状态但有具体输出的工具结果', () => {
  for (const code of ['contradicted_tool_result', 'unused_required_information'] as const) {
    const evidenceFacts = facts();
    evidenceFacts.steps[0] = { ...evidenceFacts.steps[0], status: 'unknown', outputSummary: '{"answer":42}' };
    const dimensions = qualityDimensions.map(item => (
      item.dimension === 'information_utilization'
        ? { ...item, verdict: 'partial' as const, suggestion: '使用工具返回的具体信息。' }
        : item
    ));
    const result = buildAgentTrajectoryAssessment('process-quality', evidenceFacts, qualityJudgment({
      dimensions,
      issues: [{
        code,
        severity: 'major',
        dimension: 'information_utilization',
        stepIndexes: [0, 2],
        reason: '工具返回了具体结果但终态回答没有正确使用。',
        suggestion: '根据工具结果完成回答。',
      }],
    }));
    assert.equal(result.issues[0]?.code, code);
  }
});

test('关系型 grounding 不跨根用户轮次，也不把 reasoning-only 步骤当作处理中间证据', () => {
  const crossTurnFacts = facts();
  crossTurnFacts.steps = [
    { index: 0, interactionIndex: 1, depth: 0, kind: 'tool', name: 'search', status: 'ok', outputSummary: '{"answer":42}' },
    { index: 1, interactionIndex: 2, depth: 0, kind: 'user', status: 'unknown', textSummary: '新的任务。' },
    { index: 2, interactionIndex: 3, depth: 0, kind: 'llm', name: 'answer', status: 'ok', textSummary: '新的终态回答。' },
  ];
  const dimensions = qualityDimensions.map(item => (
    item.dimension === 'information_utilization'
      ? { ...item, verdict: 'partial' as const, suggestion: '使用当前轮次信息。' }
      : item
  ));
  for (const code of ['contradicted_tool_result', 'unused_required_information'] as const) {
    assert.throws(() => buildAgentTrajectoryAssessment('process-quality', crossTurnFacts, qualityJudgment({
      dimensions,
      issues: [{
        code, severity: 'major', dimension: 'information_utilization', stepIndexes: [0, 2],
        reason: '错误跨轮引用工具结果。', suggestion: '只使用当前用户轮次证据。',
      }],
    })), JudgeOutputParseError);
  }

  const reasoningOnlyFacts = facts();
  reasoningOnlyFacts.steps = [
    { index: 0, interactionIndex: 0, depth: 0, kind: 'tool', name: 'search', status: 'ok', outputSummary: '{"answer":42}' },
    { index: 1, interactionIndex: 1, depth: 0, kind: 'llm', name: 'reasoning', status: 'ok', textSummary: '内部推理。', visibleText: false },
    { index: 2, interactionIndex: 2, depth: 0, kind: 'llm', name: 'answer', status: 'ok', textSummary: '最终回答。' },
  ];
  const efficiencyDimensionsWithPartial = efficiencyDimensions.map(item => (
    item.dimension === 'cost_efficiency'
      ? { ...item, verdict: 'partial' as const, suggestion: '删除无增益处理。' }
      : item
  ));
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', reasoningOnlyFacts, efficiencyJudgment({
    dimensions: efficiencyDimensionsWithPartial,
    issues: [{
      code: 'unused_tool_result_processing', severity: 'major', dimension: 'cost_efficiency', stepIndexes: [0, 1, 2], toolName: 'search',
      reason: '把内部推理误当处理步骤。', suggestion: '只锚定可见处理中间步骤。',
    }],
  })), JudgeOutputParseError);

  const staleFailureFacts = facts();
  staleFailureFacts.steps = [
    { index: 0, interactionIndex: 1, depth: 0, kind: 'tool', name: 'query_database', status: 'error', errorSummary: 'connection failed' },
    { index: 1, interactionIndex: 2, depth: 0, kind: 'user', status: 'unknown', textSummary: '新的任务。' },
  ];
  const exceptionDimensions = qualityDimensions.map(item => (
    item.dimension === 'exception_handling'
      ? { ...item, verdict: 'partial' as const, suggestion: '处理当前轮次错误。' }
      : item
  ));
  assert.throws(() => buildAgentTrajectoryAssessment('process-quality', staleFailureFacts, qualityJudgment({
    dimensions: exceptionDimensions,
    issues: [{
      code: 'unhandled_recoverable_error', severity: 'major', dimension: 'exception_handling', stepIndexes: [0], toolName: 'query_database',
      reason: '错误跨轮引用失败步骤。', suggestion: '只使用当前用户轮次证据。',
    }],
  })), JudgeOutputParseError);
});

test('过度回滚在多个失败点中按真实时间寻找可成立的失败关系', () => {
  const temporalFacts = facts();
  temporalFacts.steps = [
    { index: 0, interactionIndex: 4, depth: 1, kind: 'tool', name: 'deploy', status: 'error' },
    { index: 1, interactionIndex: 1, depth: 0, kind: 'tool', name: 'deploy', status: 'ok' },
    { index: 2, interactionIndex: 2, depth: 1, kind: 'tool', name: 'deploy', status: 'error' },
    { index: 3, interactionIndex: 3, depth: 0, kind: 'tool', name: 'deploy', status: 'ok' },
  ];
  const dimensions = efficiencyDimensions.map(item => (
    item.dimension === 'retry_efficiency'
      ? { ...item, verdict: 'partial' as const, suggestion: '只重试失败步骤。' }
      : item
  ));
  const result = buildAgentTrajectoryAssessment('step-efficiency', temporalFacts, efficiencyJudgment({
    dimensions,
    issues: [{
      code: 'overrollback',
      severity: 'major',
      dimension: 'retry_efficiency',
      stepIndexes: [0, 1, 2, 3],
      toolName: 'deploy',
      reason: '第二个失败点前后存在无依据的重做。',
      suggestion: '只重试失败步骤。',
    }],
  }));
  assert.equal(result.issues[0]?.code, 'overrollback');
});

test('只重试失败步骤不会被事实层误判为过度回滚', () => {
  const retryFacts = facts();
  retryFacts.steps = [
    {
      index: 0,
      interactionIndex: 0,
      depth: 0,
      kind: 'tool',
      name: 'read_file',
      argsFingerprint: 'read-config',
      status: 'ok',
    },
    {
      index: 1,
      interactionIndex: 1,
      depth: 0,
      kind: 'tool',
      name: 'write_file',
      argsFingerprint: 'write-report',
      status: 'timeout',
    },
    {
      index: 2,
      interactionIndex: 2,
      depth: 0,
      kind: 'tool',
      name: 'write_file',
      argsFingerprint: 'write-report',
      status: 'ok',
    },
  ];

  const result = buildAgentTrajectoryAssessment('step-efficiency', retryFacts, efficiencyJudgment());

  assert.equal(result.issues.some(issue => issue.code === 'overrollback'), false);
  assert.equal(result.score, 100);
});

test('失败使前序状态失效时不会仅凭调用结构判定为过度回滚', () => {
  const recoveryFacts = facts();
  recoveryFacts.steps = [
    {
      index: 0,
      interactionIndex: 0,
      depth: 0,
      kind: 'tool',
      name: 'authenticate',
      argsFingerprint: 'account-a',
      status: 'ok',
    },
    {
      index: 1,
      interactionIndex: 1,
      depth: 0,
      kind: 'tool',
      name: 'submit',
      argsFingerprint: 'request-a',
      status: 'error',
      errorSummary: 'session expired',
    },
    {
      index: 2,
      interactionIndex: 2,
      depth: 0,
      kind: 'tool',
      name: 'authenticate',
      argsFingerprint: 'account-a',
      status: 'ok',
    },
    {
      index: 3,
      interactionIndex: 3,
      depth: 0,
      kind: 'tool',
      name: 'submit',
      argsFingerprint: 'request-a',
      status: 'ok',
    },
  ];

  const result = buildAgentTrajectoryAssessment('step-efficiency', recoveryFacts, efficiencyJudgment());

  assert.equal(result.issues.some(issue => issue.code === 'overrollback'), false);
  assert.equal(result.score, 100);
});

test('关系型问题拒绝缺少必要步骤关系的单步锚点', () => {
  const cases = [
    ['step-efficiency', 'excessive_detour', 'path_detour'],
    ['step-efficiency', 'overrollback', 'retry_efficiency'],
    ['process-quality', 'contradicted_tool_result', 'information_utilization'],
    ['process-quality', 'decision_thrashing', 'path_robustness'],
    ['process-quality', 'internal_contradiction', 'reasoning_coherence'],
    ['process-quality', 'unused_required_information', 'information_utilization'],
  ] as const;

  for (const [kind, code, dimension] of cases) {
    const baseDimensions = kind === 'step-efficiency' ? efficiencyDimensions : qualityDimensions;
    const dimensions = baseDimensions.map(item => (
      item.dimension === dimension ? { ...item, verdict: 'partial' as const, suggestion: '修复关系问题。' } : item
    ));
    const judgment = kind === 'step-efficiency'
      ? efficiencyJudgment({ dimensions, issues: [{ code, severity: 'major', dimension, stepIndexes: [0], toolName: 'search', reason: '声称存在关系问题。', suggestion: '修复关系问题。' }] })
      : qualityJudgment({ dimensions, issues: [{ code, severity: 'major', dimension, stepIndexes: [0], toolName: 'search', reason: '声称存在关系问题。', suggestion: '修复关系问题。' }] });
    assert.throws(
      () => buildAgentTrajectoryAssessment(kind, facts(), judgment),
      JudgeOutputParseError,
      code,
    );
  }
});

test('可恢复错误是轨迹最后动作时允许单个失败调用锚点', () => {
  const evidenceFacts = facts();
  evidenceFacts.steps = [
    { index: 0, interactionIndex: 0, depth: 0, kind: 'user', status: 'unknown', textSummary: '查询数据库，连接失败时恢复。' },
    { index: 1, interactionIndex: 1, depth: 0, kind: 'tool', name: 'query_database', status: 'error', errorSummary: 'connection failed' },
  ];

  const assessment = buildAgentTrajectoryAssessment('process-quality', evidenceFacts, qualityJudgment({
    dimensions: [
      qualityDimensions[0],
      qualityDimensions[1],
      qualityDimensions[2],
      { ...qualityDimensions[3], verdict: 'partial', reason: '连接失败后轨迹直接结束。', suggestion: '尝试重连或安全降级。' },
      qualityDimensions[4],
      qualityDimensions[5],
    ],
    issues: [{
      code: 'unhandled_recoverable_error',
      severity: 'major',
      dimension: 'exception_handling',
      stepIndexes: [1],
      toolName: 'query_database',
      reason: '可恢复连接错误后没有任何恢复动作。',
      suggestion: '尝试重连或切换备用连接。',
    }],
  }));

  assert.deepEqual(assessment.issues.map(issue => issue.code), ['unhandled_recoverable_error']);
  assert.equal(assessment.score, 40);
});

test('语义问题锚点必须指向相应的 Agent 行为类型', () => {
  const cases = [
    ['step-efficiency', 'avoidable_llm_overuse', 'cost_efficiency'],
    ['process-quality', 'unsupported_reasoning_jump', 'reasoning_coherence'],
  ] as const;
  for (const [kind, code, dimension] of cases) {
    const baseDimensions = kind === 'step-efficiency' ? efficiencyDimensions : qualityDimensions;
    const dimensions = baseDimensions.map(item => (
      item.dimension === dimension ? { ...item, verdict: 'partial' as const, suggestion: '修正锚点。' } : item
    ));
    const issue = { code, severity: 'major' as const, dimension, stepIndexes: [0], toolName: 'search', reason: '错误地锚定工具步骤。', suggestion: '改为锚定真实决策步骤。' };
    const judgment = kind === 'step-efficiency'
      ? efficiencyJudgment({ dimensions, issues: [issue] })
      : qualityJudgment({ dimensions, issues: [issue] });
    assert.throws(() => buildAgentTrajectoryAssessment(kind, facts(), judgment), JudgeOutputParseError, code);
  }
});

test('16 个 code 固定维度封顶、总分封顶、附加封顶与确定性候选映射', () => {
  const rules = [
    ['step-efficiency', 'duplicate_no_gain', 'step_necessity', [0, 1, 2], 40, 50, 50, null, 'repeatedSameResultCandidates'],
    ['step-efficiency', 'irrelevant_detour', 'path_detour', [0], 30, 40, 40, null, null],
    ['step-efficiency', 'unchanged_retry_loop', 'retry_efficiency', [0, 1], 20, 40, 40, null, 'unchangedRetryCandidates'],
    ['step-efficiency', 'avoidable_llm_overuse', 'cost_efficiency', [2], 30, 50, 50, null, null],
    ['step-efficiency', 'fragmented_mergeable_steps', 'step_density', [0, 1, 2], 50, 60, 60, null, 'consecutiveSimilarCandidates'],
    ['step-efficiency', 'excessive_detour', 'path_detour', [0, 1, 2], 20, 30, 30, ['step_necessity', 30], null],
    ['step-efficiency', 'unused_tool_result_processing', 'cost_efficiency', [0, 1, 2], 30, 50, 50, null, null],
    ['step-efficiency', 'overrollback', 'retry_efficiency', [0, 1, 2], 20, 40, 40, null, null],
    ['process-quality', 'goal_drift', 'goal_alignment', [0], 40, 50, 50, null, null],
    ['process-quality', 'missing_required_step', 'planning_completeness', [0], 30, 50, 50, null, null],
    ['process-quality', 'unsupported_reasoning_jump', 'reasoning_coherence', [2], 40, 50, 50, null, null],
    ['process-quality', 'unhandled_recoverable_error', 'exception_handling', [0, 2], 30, 40, 40, null, null],
    ['process-quality', 'contradicted_tool_result', 'information_utilization', [0, 2], 30, 50, 50, null, null],
    ['process-quality', 'decision_thrashing', 'path_robustness', [0, 1, 2], 30, 40, 40, null, null],
    ['process-quality', 'internal_contradiction', 'reasoning_coherence', [0, 1], 30, 40, 40, null, null],
    ['process-quality', 'unused_required_information', 'information_utilization', [0, 2], 50, 60, 60, null, null],
  ] as const;

  for (const [kind, code, dimension, stepIndexes, dimensionCap, totalCap, expectedTotal, additionalCap, deterministicCandidate] of rules) {
    const evidenceFacts = facts();
    if (code === 'overrollback') {
      evidenceFacts.steps = [
        { ...evidenceFacts.steps[0], status: 'ok' },
        { ...evidenceFacts.steps[1], status: 'error' },
        { ...evidenceFacts.steps[0], index: 2, interactionIndex: 2, status: 'ok' },
      ];
    } else if (code === 'unhandled_recoverable_error') {
      evidenceFacts.steps[0] = { ...evidenceFacts.steps[0], status: 'error' };
    } else if (code === 'decision_thrashing') {
      evidenceFacts.steps = evidenceFacts.steps.map(step => ({ ...step, kind: 'llm' as const, name: undefined }));
    } else if (code === 'internal_contradiction') {
      evidenceFacts.steps[0] = { ...evidenceFacts.steps[0], kind: 'llm', name: undefined };
      evidenceFacts.steps[1] = { ...evidenceFacts.steps[1], kind: 'llm', name: undefined };
    } else if (code === 'unused_tool_result_processing') {
      evidenceFacts.steps[1] = { ...evidenceFacts.steps[1], kind: 'llm', name: 'process', textSummary: '整理工具结果。' };
    } else if (code !== 'contradicted_tool_result'
      && code !== 'unused_required_information'
      && code !== 'avoidable_llm_overuse'
      && code !== 'unsupported_reasoning_jump') {
      evidenceFacts.steps[2] = { ...evidenceFacts.steps[2], kind: 'tool', name: 'search' };
    }
    evidenceFacts.candidates = {
      repeatedSameCallCandidates: [candidate([0, 1, 2])],
      repeatedSameResultCandidates: [candidate([0, 1, 2])],
      unchangedRetryCandidates: [candidate([0, 1])],
      consecutiveSimilarCandidates: [candidate([0, 1, 2])],
    };
    const dimensions = (kind === 'step-efficiency' ? efficiencyDimensions : qualityDimensions).map(item => (
      item.dimension === dimension ? { ...item, verdict: 'partial', suggestion: '修复该问题。' } : item
    ));
    const anchoredStepIndexes = new Set<number>(stepIndexes);
    const anchoredTools = evidenceFacts.steps.filter(step => anchoredStepIndexes.has(step.index) && step.kind === 'tool');
    const toolName = anchoredTools.length > 0 && anchoredTools.every(step => step.name === 'search')
      ? { toolName: 'search' }
      : {};
    const issue = { code, severity: 'critical' as const, dimension, stepIndexes, ...toolName, reason: '已锚定问题。', suggestion: '修复该问题。' };
    const judgment = kind === 'step-efficiency'
      ? efficiencyJudgment({ dimensions, issues: [issue] })
      : qualityJudgment({ dimensions, issues: [issue] });
    const assessment = buildAgentTrajectoryAssessment(kind, evidenceFacts, judgment);
    assert.deepEqual(
      assessment.appliedCaps.filter(item => item.scope !== 'additional-dimension').map(item => [item.scope, item.dimension, item.cap]),
      [['dimension', dimension, dimensionCap], ['total', dimension, totalCap]],
      code,
    );
    assert.deepEqual(
      assessment.appliedCaps.filter(item => item.scope === 'additional-dimension').map(item => [item.dimension, item.cap]),
      additionalCap === null ? [] : [additionalCap],
      code,
    );
    const cappedDimension = assessment.dimensions.find(item => item.dimension === dimension);
    assert.equal(cappedDimension?.rawScore, 50, code);
    assert.equal(cappedDimension?.score, Math.min(50, dimensionCap), code);
    if (additionalCap !== null) {
      const [additionalDimension, additionalDimensionCap] = additionalCap;
      const additionallyCapped = assessment.dimensions.find(item => item.dimension === additionalDimension);
      assert.equal(additionallyCapped?.rawScore, 100, code);
      assert.equal(additionallyCapped?.score, additionalDimensionCap, code);
    }
    assert.equal(assessment.score, expectedTotal, code);
    assert.equal(assessment.issues[0]?.code, code, deterministicCandidate ?? code);
  }
});

test('多个封顶取最小值，并记录所有实际收紧的 appliedCaps', () => {
  const dimensions = [
    efficiencyDimensions[0],
    { ...efficiencyDimensions[1], verdict: 'partial', suggestion: '删除绕路。' },
    { ...efficiencyDimensions[2], verdict: 'partial', suggestion: '复用已有结果。' },
    efficiencyDimensions[3],
    efficiencyDimensions[4],
  ];
  const assessment = buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions,
    issues: [
      { code: 'avoidable_llm_overuse', severity: 'major', dimension: 'cost_efficiency', stepIndexes: [2], reason: '无新增信息。', suggestion: '复用工具结果。' },
      { code: 'irrelevant_detour', severity: 'major', dimension: 'path_detour', stepIndexes: [1], toolName: 'search', reason: '绕路。', suggestion: '直接执行。' },
    ],
  }));
  assert.equal(assessment.baseScore, 72);
  assert.equal(assessment.score, 40);
  assert.deepEqual(assessment.appliedCaps, [
    { code: 'avoidable_llm_overuse', scope: 'dimension', dimension: 'cost_efficiency', cap: 30 },
    { code: 'avoidable_llm_overuse', scope: 'total', dimension: 'cost_efficiency', cap: 50 },
    { code: 'irrelevant_detour', scope: 'dimension', dimension: 'path_detour', cap: 30 },
    { code: 'irrelevant_detour', scope: 'total', dimension: 'path_detour', cap: 40 },
  ]);
});

test('六维按等权计算并将基础分保留一位小数', () => {
  const evidenceFacts = facts();
  evidenceFacts.steps = evidenceFacts.steps.map(step => ({ ...step, kind: 'llm' as const, name: undefined }));
  const assessment = buildAgentTrajectoryAssessment('process-quality', evidenceFacts, qualityJudgment({
    dimensions: [
      qualityDimensions[0],
      qualityDimensions[1],
      qualityDimensions[2],
      qualityDimensions[3],
      { ...qualityDimensions[4], verdict: 'partial', suggestion: '减少无依据切换。' },
      qualityDimensions[5],
    ],
    issues: [{
      code: 'decision_thrashing', severity: 'major', dimension: 'path_robustness', stepIndexes: [0, 1, 2], reason: '没有新证据却切换方案。', suggestion: '保留证据驱动的方案切换。',
    }],
  }));
  assert.equal(assessment.dimensions.find(item => item.dimension === 'path_robustness')?.score, 30);
  assert.equal(assessment.baseScore, 88.3);
  assert.equal(assessment.score, 40);
});

test('有效问题计分，失效同维问题仅进入 discardedIssues', () => {
  const assessment = buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [
      efficiencyDimensions[0],
      { ...efficiencyDimensions[1], verdict: 'partial', suggestion: '删除绕路。' },
      efficiencyDimensions[2],
      efficiencyDimensions[3],
      efficiencyDimensions[4],
    ],
    issues: [
      { code: 'irrelevant_detour', severity: 'major', dimension: 'path_detour', stepIndexes: [0], toolName: 'search', reason: '绕路。', suggestion: '直接执行。' },
      { code: 'irrelevant_detour', severity: 'major', dimension: 'path_detour', stepIndexes: [99], toolName: 'search', reason: '虚构步骤。', suggestion: '删除虚构证据。' },
    ],
  }));
  assert.equal(assessment.issues.length, 1);
  assert.equal(assessment.discardedIssues.length, 1);
  assert.equal(assessment.discardedIssues[0]?.discardReason, '问题引用了不存在的轨迹步骤。');
  assert.equal(assessment.score, 40);
});

test('Judge 严格 schema 拒绝旧兼容字段、分数、权重、封顶和额外字段', () => {
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    legacyCompatibility: { toolChoice: { verdict: 'met', reason: '无。' }, redundancy: { verdict: 'met', reason: '无。' }, keyActions: [] },
  })), JudgeOutputParseError);
  assert.throws(() => buildAgentTrajectoryAssessment('process-quality', facts(), qualityJudgment({
    legacyCompatibility: { toolChoice: { verdict: 'met', reason: '无。' }, redundancy: { verdict: 'met', reason: '无。' }, keyActions: [] },
  })), JudgeOutputParseError);
  for (const field of ['score', 'weight', 'cap', 'unrecognized'] as const) {
    assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), {
      ...efficiencyJudgment(),
      [field]: field === 'score' ? 0 : 1,
    }), JudgeOutputParseError, field);
  }
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions: [{ ...efficiencyDimensions[0], judgeControlledField: true }, ...efficiencyDimensions.slice(1)],
  })), JudgeOutputParseError);
});

test('toolName 必须覆盖所有锚定的具名工具步骤，而非工具步骤不强制名称一致', () => {
  const mixedToolFacts = facts();
  mixedToolFacts.steps[1] = { ...mixedToolFacts.steps[1], name: 'fetch' };
  const dimensions = [
    efficiencyDimensions[0],
    { ...efficiencyDimensions[1], verdict: 'partial', suggestion: '删除绕路。' },
    efficiencyDimensions[2],
    efficiencyDimensions[3],
    efficiencyDimensions[4],
  ];
  assert.throws(() => buildAgentTrajectoryAssessment('step-efficiency', mixedToolFacts, efficiencyJudgment({
    dimensions,
    issues: [{ code: 'irrelevant_detour', severity: 'major', dimension: 'path_detour', stepIndexes: [0, 1], toolName: 'search', reason: '绕路。', suggestion: '直接执行。' }],
  })), JudgeOutputParseError);
  const omittedToolName = buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions,
    issues: [{ code: 'irrelevant_detour', severity: 'major', dimension: 'path_detour', stepIndexes: [0, 2], reason: '绕路。', suggestion: '直接执行。' }],
  }));
  assert.equal(omittedToolName.issues.length, 1);
  const assessment = buildAgentTrajectoryAssessment('step-efficiency', facts(), efficiencyJudgment({
    dimensions,
    issues: [{ code: 'irrelevant_detour', severity: 'major', dimension: 'path_detour', stepIndexes: [0, 2], toolName: 'search', reason: '绕路。', suggestion: '直接执行。' }],
  }));
  assert.equal(assessment.issues.length, 1);
  const mixedWithoutToolName = buildAgentTrajectoryAssessment('step-efficiency', mixedToolFacts, efficiencyJudgment({
    dimensions,
    issues: [{ code: 'irrelevant_detour', severity: 'major', dimension: 'path_detour', stepIndexes: [0, 1], reason: '绕路。', suggestion: '直接执行。' }],
  }));
  assert.equal(mixedWithoutToolName.issues.length, 1);
});
