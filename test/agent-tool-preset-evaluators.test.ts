/** Agent Tool/Skill 专项评估器的上下文、轨迹事实和确定性计分测试。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EvaluatorContextValidationError,
  listEvaluatorCapabilities,
  normalizeEvaluatorCaseContext,
  parseStoredEvaluatorCaseContext,
} from '@/lib/evaluators/evaluator-case-context';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import { extractToolTraceFacts, type ToolTraceFacts } from '@/lib/engine/experiment/agent-tool-trace-facts';
import {
  buildUtilizationEvaluatorOutput,
} from '@/lib/engine/experiment/agent-tool-utilization-evaluator';
import {
  buildSelectionEvaluatorOutput,
  runToolSelectionPreset,
  type SelectionJudgeResult,
} from '@/lib/engine/experiment/agent-tool-selection-evaluator';

interface SuiteEvidenceJson {
  rubricVersion?: string;
  capabilityClassifications?: Array<{
    kind?: string;
    name?: string;
    relevance?: string;
    called?: boolean;
    reason?: string;
    idleReason?: string;
  }>;
  statistics?: {
    requiredCapabilityCoverage?: number | null;
    callMatchRate?: number | null;
    callRestraintRate?: number | null;
    discardedJudgeIssues?: Array<{ discardReason?: string }>;
  };
  issues?: Array<{ code?: string; dimension?: string; stepIndex?: number | null }>;
  suggestions?: string[];
  appliedCap?: { value?: number };
  unscoredReason?: string;
}

function evidenceJson(output: { evidence?: unknown }): SuiteEvidenceJson {
  return ((output.evidence as { json?: SuiteEvidenceJson } | undefined)?.json ?? {});
}

function capExplanation(output: { points?: Array<{ label: string; evidence?: unknown }> }): string {
  const point = output.points?.find((item) => item.label === '总分封顶说明');
  return (point?.evidence as { md?: string } | undefined)?.md ?? '';
}

function facts(inputs: Array<string | { kind: 'tool' | 'skill'; name: string }>): ToolTraceFacts {
  const calls = inputs.map((input, stepIndex) => {
    const kind = typeof input === 'string' ? 'tool' : input.kind;
    const name = typeof input === 'string' ? input : input.name;
    const canonicalName = name.toLowerCase();
    return {
      stepIndex,
      anchor: `step-${stepIndex}` as `step-${number}`,
      kind,
      name,
      canonicalName,
      canonicalKey: `${kind}:${canonicalName}`,
      args: { value: stepIndex },
      result: { ok: true },
      status: 'completed',
      errorMessage: null,
      errorCode: null,
      interactionIndex: stepIndex,
    };
  });
  const countsByCapability: Record<string, number> = {};
  for (const call of calls) {
    countsByCapability[call.canonicalKey] = (countsByCapability[call.canonicalKey] ?? 0) + 1;
  }
  const calledCatalogCapabilities = [...new Map(calls.map((call) => [call.canonicalKey, {
    kind: call.kind, name: call.name, canonicalKey: call.canonicalKey,
  }])).values()];
  return {
    calls,
    countsByCapability,
    calledCatalogCapabilities,
    unknownCalledCapabilities: [],
    usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, llmCallCount: 0, toolCallCount: 0, failedTurnTokens: 0, failedToolDurationMs: 0 },
  };
}

const selectionDimensions = (): SelectionJudgeResult['dimensions'] => [
  { dimension: 'tool_necessity', verdict: 'met', reason: '', suggestion: '' },
  { dimension: 'tool_match', verdict: 'met', reason: '', suggestion: '' },
  { dimension: 'parameter_validity', verdict: 'met', reason: '', suggestion: '' },
  { dimension: 'result_utilization', verdict: 'met', reason: '', suggestion: '' },
  { dimension: 'call_order', verdict: 'met', reason: '', suggestion: '' },
];

describe('Tool/Skill 上下文与轨迹事实', () => {
  it('区分缺失与空目录，并规范化 Tool/Skill 的独立身份', () => {
    assert.equal(normalizeEvaluatorCaseContext(undefined), null);
    assert.deepEqual(
      normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [] }),
      { schemaVersion: 1, availableTools: [] },
    );

    const context = normalizeEvaluatorCaseContext({
      schemaVersion: 1,
      availableTools: [
        { name: ' Search ', description: ' 检索 ', inputSchema: { type: 'object' } },
        { name: 'search', description: '重复项' },
      ],
      availableSkills: [{ name: 'search' }, { name: ' research_playbook ' }],
    });
    assert.deepEqual(context, {
      schemaVersion: 1,
      availableTools: [{ name: 'Search', description: '检索', inputSchema: { type: 'object' } }],
      availableSkills: [{ name: 'search' }, { name: 'research_playbook' }],
    });
    assert.deepEqual(listEvaluatorCapabilities(context!), [
      { kind: 'tool', name: 'Search', description: '检索', inputSchema: { type: 'object' } },
      { kind: 'skill', name: 'search' },
      { kind: 'skill', name: 'research_playbook' },
    ]);

    const opencodeContext = normalizeEvaluatorCaseContext({
      schemaVersion: 1,
      availableTools: [
        { name: 'bash' },
        { name: 'skill' },
        { name: 'load_skill' },
        { name: 'skill_view' },
        { name: 'skill_tool' },
      ],
      availableSkills: [{ name: 'release-summary' }],
    });
    assert.deepEqual(opencodeContext, {
      schemaVersion: 1,
      availableTools: [{ name: 'bash' }],
      availableSkills: [{ name: 'release-summary' }],
    });
    assert.deepEqual(listEvaluatorCapabilities(opencodeContext!), [
      { kind: 'tool', name: 'bash' },
      { kind: 'skill', name: 'release-summary' },
    ]);
  });

  it('拒绝非法目录，并把损坏的存量 JSON 转成可诊断结果', () => {
    assert.throws(
      () => normalizeEvaluatorCaseContext({ schemaVersion: 2, availableTools: [] }),
      EvaluatorContextValidationError,
    );
    assert.throws(
      () => normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: '' }] }),
      EvaluatorContextValidationError,
    );
    const stored = parseStoredEvaluatorCaseContext('{bad');
    assert.equal(stored.context, null);
    assert.match(stored.error ?? '', /有效 JSON/);
  });

  it('提取 Tool/Skill 调用事实并排除 Agent 委派', () => {
    const extracted = extractToolTraceFacts([{
      role: 'assistant',
      tool_calls: [
        { id: 's1', name: 'skill', arguments: '{"name":"research_playbook"}', state: 'completed' },
        { id: 'a1', name: 'task', arguments: '{"subagent_type":"worker"}', state: 'completed' },
        {
          id: 't1', name: 'get_weather', arguments: '{"city":"北京"}',
          state: 'completed', output: { temp: 30 },
        },
        { id: 't2', name: 'get_weather', arguments: '{"city":"上海"}', state: 'error' },
      ],
    }], [
      { kind: 'skill', name: 'research_playbook' },
      { kind: 'tool', name: 'get_weather' },
    ]);

    assert.deepEqual(extracted.calls.map((call) => ({ kind: call.kind, name: call.name })), [
      { kind: 'skill', name: 'research_playbook' },
      { kind: 'tool', name: 'get_weather' },
      { kind: 'tool', name: 'get_weather' },
    ]);
    assert.deepEqual(extracted.calls[1].args, { city: '北京' });
    assert.deepEqual(extracted.calls[1].result, { temp: 30 });
    assert.equal(extracted.calls[2].status, 'error');
    assert.equal(extracted.countsByCapability['tool:get_weather'], 2);
    assert.equal(extracted.calls.some((call) => call.name === 'task'), false);
  });

  it('混合成功失败 interaction：失败 Token 按回合计量，失败耗时按工具自身 timing 计量', () => {
    const interactions = [{
      role: 'assistant' as const,
      usage: { total: 1200 },
      tool_calls: [
        { id: 'ok', name: 'search', arguments: '{}', state: 'completed', timing: { started_at: 10_000_000_000, completed_at: 10_000_000_200 } },
        { id: 'bad', name: 'read', arguments: '{}', state: 'error', timing: { started_at: 10_000_000_200, completed_at: 10_000_000_400 } },
        { id: 'bad2', name: 'read', arguments: '{}', state: 'error', timing: { started_at: 10_000_000_400, completed_at: 10_000_000_600 } },
      ],
    }];
    const extracted = extractToolTraceFacts(interactions, [
      { kind: 'tool', name: 'search' },
      { kind: 'tool', name: 'read' },
    ]);

    // 回合级 Token：整个 interaction 的 usage.total 归入失败回合消耗（含成功调用），口径明确为「回合」
    assert.equal(extracted.usage.failedTurnTokens, 1200);
    // 工具级耗时：只有两次 error 调用的 timing 跨度累加（200+200=400ms），成功调用不计
    assert.equal(extracted.usage.failedToolDurationMs, 400);
  });
});

describe('Agent Tool/Skill 专项评估器确定性计分', () => {
  it('工具利用率以三个互斥比例聚合 Tool/Skill 调用，并保留 step 依据', () => {
    const availableCapabilities = [
      { kind: 'tool' as const, name: 'read' },
      { kind: 'skill' as const, name: 'summarize' },
      { kind: 'tool' as const, name: 'translate' },
    ];
    const output = buildUtilizationEvaluatorOutput({
      availableCapabilities,
      facts: facts([
        { kind: 'tool', name: 'read' },
        { kind: 'skill', name: 'summarize' },
        { kind: 'tool', name: 'read' },
        { kind: 'tool', name: 'translate' },
        { kind: 'tool', name: 'web_search' },
      ]),
      judgment: {
        summary: '必要能力均有覆盖，但存在一次重复调用和两次不匹配调用。',
        capabilities: [
          { kind: 'tool', name: 'read', relevance: 'required', reason: '需要读取文件', idleReason: '' },
          { kind: 'skill', name: 'summarize', relevance: 'optional', reason: '可辅助归纳', idleReason: '' },
          { kind: 'tool', name: 'translate', relevance: 'irrelevant', reason: '中文任务', idleReason: '无需翻译' },
        ],
        callFindings: [
          {
            stepIndex: 2, classification: 'redundant',
            reason: 'step-2 再次读取同一文件，step-0 已取得任务所需内容。',
            suggestion: '复用 step-0 的读取结果。',
          },
          {
            stepIndex: 3, classification: 'irrelevant',
            reason: 'step-3 调用 translate，但任务要求中文输出且目录中的 tool:translate 被判为无关。',
            suggestion: '跳过与任务无关的翻译调用。',
          },
          {
            stepIndex: 4, classification: 'out_of_catalog',
            reason: 'step-4 调用 web_search，但 capability_catalog 中没有 tool:web_search。',
            suggestion: '只调用目录中声明的能力。',
          },
        ],
      },
    });

    assert.equal(output.score, 81.7);
    assert.equal(output.summary, '必要能力均有覆盖，但存在一次重复调用和两次不匹配调用。');
    assert.equal(evidenceJson(output).statistics?.requiredCapabilityCoverage, 100);
    assert.equal(evidenceJson(output).statistics?.callMatchRate, 60);
    assert.equal(evidenceJson(output).statistics?.callRestraintRate, 66.7);
    assert.deepEqual(evidenceJson(output).capabilityClassifications, [
      { kind: 'tool', name: 'read', relevance: 'required', called: true, reason: '需要读取文件', idleReason: '' },
      { kind: 'skill', name: 'summarize', relevance: 'optional', called: true, reason: '可辅助归纳', idleReason: '' },
      { kind: 'tool', name: 'translate', relevance: 'irrelevant', called: true, reason: '中文任务', idleReason: '无需翻译' },
    ]);
    const coveragePoint = output.points?.find((point) => point.label === '必要能力覆盖率');
    assert.deepEqual(
      (coveragePoint?.evidence as { json?: SuiteEvidenceJson } | undefined)?.json?.capabilityClassifications,
      evidenceJson(output).capabilityClassifications,
    );
    assert.deepEqual(
      evidenceJson(output).issues?.map((issue) => [issue.dimension, issue.stepIndex]),
      [
        ['call_restraint_rate', 2],
        ['call_match_rate', 3],
        ['call_match_rate', 4],
      ],
    );
    assert.equal(evidenceJson(output).appliedCap, undefined);
  });

  it('合理闲置和遗漏必要能力按 N/A 重归一规则处理，不再触发封顶', () => {
    const idle = buildUtilizationEvaluatorOutput({
      availableCapabilities: [{ kind: 'tool' as const, name: 'translate' }],
      facts: facts([]),
      judgment: {
        capabilities: [{
          kind: 'tool', name: 'translate', relevance: 'irrelevant',
          reason: '任务只要求中文说明', idleReason: '无需翻译',
        }],
      },
    });
    assert.equal(idle.score, 100);
    assert.equal(evidenceJson(idle).statistics?.requiredCapabilityCoverage, null);
    assert.equal(evidenceJson(idle).statistics?.callMatchRate, null);

    const missing = buildUtilizationEvaluatorOutput({
      availableCapabilities: [{ kind: 'tool' as const, name: 'read' }],
      facts: facts([]),
      judgment: {
        capabilities: [{
          kind: 'tool', name: 'read', relevance: 'required',
          reason: '任务需要读取输入文件', idleReason: '未调用该必要能力',
        }],
      },
    });
    assert.equal(missing.score, 0);
    assert.equal(evidenceJson(missing).statistics?.requiredCapabilityCoverage, 0);
    assert.equal(evidenceJson(missing).appliedCap, undefined);

    assert.throws(() => buildUtilizationEvaluatorOutput({
      availableCapabilities: [{ kind: 'tool', name: 'search' }],
      facts: facts([]),
      judgment: { capabilities: [] },
    }), JudgeOutputParseError);
  });

  it('工具选择只让锚定到真实步骤的问题触发严重封顶', () => {
    const availableCapabilities = ['read', 'get_weather'].map((name) => ({ kind: 'tool' as const, name }));
    const grounded = buildSelectionEvaluatorOutput({
      availableCapabilities,
      facts: facts(['read', 'get_weather']),
      judgment: {
        summary: '五个维度整体合理，但存在一个关键参数缺少上下文来源。',
        dimensions: selectionDimensions(),
        issues: [
          {
            code: 'hallucinated_critical_argument', severity: 'critical', dimension: 'tool_match',
            capabilityKind: 'tool', toolName: 'wrong-name', stepIndex: 1,
            reason: '城市没有上下文来源', suggestion: '从上下文获取城市',
          },
          {
            code: 'wrong_core_tool', severity: 'major', dimension: 'tool_match',
            capabilityKind: 'tool', toolName: 'invented', stepIndex: 99,
            reason: '不存在的步骤', suggestion: '无',
          },
        ],
      },
    });
    assert.equal(grounded.score, 40);
    assert.equal(grounded.summary, '五个维度整体合理，但存在一个关键参数缺少上下文来源。');
    assert.equal(evidenceJson(grounded).appliedCap?.value, 40);
    assert.match(capExplanation(grounded), /关键参数缺少依据.*step-1.*封顶为 40 分/);
    assert.deepEqual(
      grounded.points?.find((point) => point.label === '参数合理性')?.anchors,
      ['step-1'],
    );
    assert.match(
      evidenceJson(grounded).statistics?.discardedJudgeIssues?.[0]?.discardReason ?? '',
      /真实/,
    );

    const ungrounded = buildSelectionEvaluatorOutput({
      availableCapabilities,
      facts: facts(['get_weather']),
      judgment: {
        dimensions: selectionDimensions(),
        issues: [{
          code: 'wrong_core_tool', severity: 'major', dimension: 'tool_match',
          capabilityKind: 'tool', toolName: 'invented', stepIndex: 99,
          reason: '不存在的步骤', suggestion: '无',
        }],
      },
    });
    assert.equal(ungrounded.score, 100);
    assert.equal(evidenceJson(ungrounded).appliedCap, undefined);
  });

  it('工具目录缺失时返回不计分结果，而不是伪造 0 分', async () => {
    const output = await runToolSelectionPreset('u', {
      caseInput: '查数据库人数', actualOutput: '100 万', referenceOutput: null,
      traceSummaryText: null, interactions: [], taskId: null, executionId: null,
      evaluatorContext: null,
    });
    assert.equal(output.score, undefined);
    assert.match(output.summary ?? '', /无法完成工具类评估/);
    assert.match(evidenceJson(output).unscoredReason ?? '', /未提供 Tool\/Skill 目录/);
  });
});
