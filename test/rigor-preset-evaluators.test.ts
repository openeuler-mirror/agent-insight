/** 内容严谨性评估器的 Judge 契约、原文校验、审计回填与确定性计分测试。 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, test } from 'node:test';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import {
  buildRigorEvaluatorOutput,
  rigorDetailOf,
  runRigorPreset,
  type RigorFinding,
} from '@/lib/engine/experiment/rigor-preset-evaluators';
import type { EvaluatorOutput } from '@/lib/evaluators/eval-output';
import type { ContentRigorDimension, ContentRigorSeverity } from '@/prompts/rigor-content-prompt';

interface RigorEvidenceJson {
  rubricVersion?: string;
  judgeSummary?: string | null;
  baseScore?: number;
  totalDeduction?: number;
  appliedCap?: { value: number; reason: string; effective?: boolean };
  findings?: Array<{ severity?: string; correction?: string }>;
  discardedFindings?: Array<{ discardReason: string }>;
  reclassifiedFindings?: Array<{ originalDimension?: string; originalSeverity?: string; dimension?: string }>;
  repairedFindings?: Array<{ originalQuote: string; repairReason: string; quote?: string }>;
  dedupedFindings?: Array<{ dedupReason: string }>;
  upgradedFindings?: Array<{ originalSeverity: string; severity?: string; upgradeReason: string }>;
  downgradedFindings?: Array<{ originalSeverity: string; severity: string }>;
  backfilledFindings?: Array<{ backfillReason: string }>;
}

/**
 * 代码侧裁决明细。评估器级 evidence 已改为自然语言 md，明细改走 rigorDetailOf 旁路，
 * 所以这个 helper 换了取数口径——下面 73 处断言一个字都不用动。
 */
function evidenceJson(output: EvaluatorOutput): RigorEvidenceJson {
  return rigorDetailOf(output) as RigorEvidenceJson;
}

/** 评估器级 md 证据（原来这里是一坨 JSON）。 */
const evidenceMd = (output: EvaluatorOutput): string =>
  (output.evidence as { md?: string } | undefined)?.md ?? '';

function finding(
  dimension: ContentRigorDimension,
  severity: ContentRigorSeverity,
  quote: string,
  overrides: Partial<RigorFinding> = {},
): RigorFinding {
  return {
    dimension,
    severity,
    quote,
    reason: '测试用问题说明',
    correction: '测试用正确值',
    suggestion: '测试用修改建议',
    ...overrides,
  };
}

const build = (actualOutput: string, findings: RigorFinding[]) =>
  buildRigorEvaluatorOutput({ actualOutput, judgment: { findings } });

const pointScore = (output: { points?: Array<{ label: string; score?: number }> }, label: string) =>
  output.points?.find((point) => point.label === label)?.score;

const context = {
  caseInput: '介绍一下这个知识点',
  actualOutput: '如果商品原价 200 元，打八折后为 160 元，再满减 20 元，最终价格为 150 元。',
  referenceOutput: null,
  traceSummaryText: null,
  interactions: [],
  taskId: null,
  executionId: null,
};

afterEach(() => setJudgeLlmCallerForTest(null));

// ── 需求文档的 12 条验收用例，逐条覆盖，不抽样 ────────────────────────────────

describe('内容严谨性评估器 · 验收用例', () => {
  it('用例 1：完全正确的内容 → 100 分且各维度满分', () => {
    const text = '光在真空中的传播速度约为 3×10⁸ 米/秒。';
    const output = build(text, []);
    assert.equal(output.score, 100);
    assert.equal(output.verdict, 'pass');
    assert.equal(output.points?.length, 5);
    assert.equal(output.points?.every((point) => point.score === 100 && point.status === 'covered'), true);
  });

  it('用例 2：事实错误（日期）→ ≤40，事实准确性低分', () => {
    const text = '中华人民共和国成立于 1949 年 10 月 1 日，同一年联合国恢复了中国的合法席位。';
    const output = build(text, [
      finding('factual_accuracy', 'high', '同一年联合国恢复了中国的合法席位', {
        correction: '联合国恢复中国合法席位是 1971 年。',
      }),
    ]);
    assert.ok((output.score ?? 100) <= 40);
    assert.equal(output.score, 40);
    assert.equal(pointScore(output, '事实准确性'), 40);
    assert.equal(output.verdict, 'fail');
  });

  it('用例 3：数值计算错误 → ≤40', () => {
    const text = '如果商品原价 200 元，打八折后为 160 元，再满减 20 元，最终价格为 150 元。';
    const output = build(text, [
      finding('numerical_precision', 'high', '最终价格为 150 元', { correction: '160-20=140 元。' }),
    ]);
    assert.ok((output.score ?? 100) <= 40);
    assert.equal(output.score, 40);
  });

  it('用例 4：逻辑错误（因果混淆）→ ≤30', () => {
    const text = '统计数据显示，喝咖啡的人心脏病发病率更高，因此喝咖啡会导致心脏病。';
    const output = build(text, [
      finding('logical_correctness', 'high', '因此喝咖啡会导致心脏病', {
        correction: '相关性不等于因果性，可能存在吸烟等混杂变量。',
      }),
    ]);
    assert.ok((output.score ?? 100) <= 30);
    assert.equal(output.score, 30);
    assert.equal(pointScore(output, '逻辑正确性'), 40);
  });

  it('用例 5：操作建议错误（命令错误）→ ≤30', () => {
    const text = '要查看当前目录下的文件，请在终端中输入：list files';
    const output = build(text, [
      finding('operational_correctness', 'high', 'list files', { correction: '正确命令是 ls。' }),
    ]);
    assert.ok((output.score ?? 100) <= 30);
    assert.equal(output.score, 30);
  });

  it('用例 6：误导性表述（过于绝对）→ ≤50', () => {
    const text = '维生素 C 可以预防感冒，每天服用就行。';
    const output = build(text, [
      finding('misleading_statements', 'high', '维生素 C 可以预防感冒', {
        correction: '现有研究未证实可预防感冒，仅可能轻微缩短病程。',
      }),
    ]);
    assert.ok((output.score ?? 100) <= 50);
    assert.equal(output.score, 50);
    assert.equal(pointScore(output, '误导性表述'), 70);
  });

  it('用例 7：边界——有限定语的学术表述不扣分', () => {
    const text = '关于量子力学的哥本哈根诠释是目前最被广泛接受的解释框架。';
    assert.equal(build(text, []).score, 100);
  });

  it('用例 8：边界——标注来源与年份的引用不扣分', () => {
    const text = '根据 World Bank 2023 年数据，中国 GDP 总量约为 17.7 万亿美元。';
    assert.equal(build(text, []).score, 100);
  });

  it('用例 9：多处事实错误叠加 → ≤20', () => {
    const text = '月球是地球的卫星，直径约为 5000 公里，是太阳系中最大的卫星。'
      + '人类第一次登月是在 1970 年由阿波罗 12 号完成的。';
    const output = build(text, [
      finding('factual_accuracy', 'high', '直径约为 5000 公里', { correction: '月球直径约 3474 公里。' }),
      finding('factual_accuracy', 'high', '是太阳系中最大的卫星', { correction: '最大卫星是木卫三。' }),
      finding('factual_accuracy', 'high', '1970 年由阿波罗 12 号完成', { correction: '1969 年阿波罗 11 号。' }),
    ]);
    assert.ok((output.score ?? 100) <= 20);
    assert.equal(output.score, 0);
    // 0 分必须真的是 0，不能退化成"无分"
    assert.equal(typeof output.score, 'number');
    assert.equal(evidenceJson(output).appliedCap?.value, 20);
  });

  it('用例 10：操作建议遗漏安全警告 → ≤30，两个维度同时扣分', () => {
    const text = '要删除 Linux 系统日志，执行 rm -rf /var/log/';
    const output = build(text, [
      finding('operational_correctness', 'high', 'rm -rf /var/log/', {
        correction: '应先确认权限与备份，改用 truncate 或按文件清理。',
      }),
      finding('misleading_statements', 'medium', '要删除 Linux 系统日志', {
        correction: '需说明该操作不可恢复并提示风险。',
      }),
    ]);
    assert.ok((output.score ?? 100) <= 30);
    assert.equal(output.score, 25);
    assert.equal(pointScore(output, '操作建议正确性'), 40);
    assert.equal(pointScore(output, '误导性表述'), 85);
  });

  it('用例 11：边界——主观观点不受严谨性约束', () => {
    const text = '我认为梵高的《星空》是他最动人的作品。';
    assert.equal(build(text, []).score, 100);
  });

  it('用例 12：单位混淆 → ≤40', () => {
    const text = '该网络接口的带宽为 100 MB，足以支持 50 路 4K 视频流。';
    const output = build(text, [
      finding('numerical_precision', 'high', '带宽为 100 MB', {
        correction: '应为 100 Mbps，且不足以支撑 50 路 4K 视频流。',
      }),
    ]);
    assert.ok((output.score ?? 100) <= 40);
    assert.equal(output.score, 40);
  });
});

// ── 计分与证据契约 ──────────────────────────────────────────────────────────

describe('内容严谨性评估器 · 计分与证据', () => {
  it('低严重度问题只累计扣分，不触发封顶', () => {
    const text = '该功能大约需要三到五天完成。';
    const output = build(text, [finding('factual_accuracy', 'low', '三到五天')]);
    assert.equal(output.score, 90);
    assert.equal(output.verdict, 'warn');
    assert.equal(evidenceJson(output).appliedCap, undefined);
    assert.equal(output.points?.length, 5); // 无封顶时不追加封顶说明评分点
  });

  it('封顶实际压低分数时追加「总分封顶说明」评分点，并写明基础分', () => {
    const text = '这条命令是 list files。';
    const output = build(text, [
      finding('operational_correctness', 'high', 'list files', { correction: '应为 ls。' }),
    ]);
    const capPoint = output.points?.find((point) => point.label === '总分封顶说明');
    assert.ok(capPoint);
    assert.match((capPoint?.evidence as { md?: string })?.md ?? '', /封顶为 30 分/);
    assert.equal(evidenceJson(output).baseScore, 40);
    assert.equal(evidenceJson(output).appliedCap?.effective, true);
  });

  it('封顶未实际压低分数时（基础分已更低）不输出「总分封顶说明」', () => {
    const text = '月球直径 5000 公里，是太阳系最大的卫星，登月在 1970 年。';
    const output = build(text, [
      finding('factual_accuracy', 'high', '直径 5000 公里'),
      finding('factual_accuracy', 'high', '太阳系最大的卫星'),
      finding('factual_accuracy', 'high', '登月在 1970 年'),
    ]);
    assert.equal(output.score, 0);
    assert.ok(!output.points?.some((point) => point.label === '总分封顶说明'));
    assert.equal(evidenceJson(output).appliedCap?.effective, false);
  });

  it('每个评分点同时给出 score、status 与证据', () => {
    const text = '结论是喝咖啡会导致心脏病。';
    const output = build(text, [finding('logical_correctness', 'medium', '喝咖啡会导致心脏病')]);
    for (const point of output.points ?? []) {
      if (point.label === '总分封顶说明') continue;
      assert.equal(typeof point.score, 'number');
      assert.ok(point.status);
      assert.ok(point.evidence);
    }
  });

  it('summary 由存活 findings 生成；Judge 原话只作留档', () => {
    const output = buildRigorEvaluatorOutput({
      actualOutput: '带宽是 100 MB',
      judgment: { summary: '模型自由发挥的一句话', findings: [] },
    });
    assert.equal(output.score, 100);
    assert.notEqual(output.summary, '模型自由发挥的一句话');
    assert.equal(evidenceJson(output).judgeSummary, '模型自由发挥的一句话');
    // 留档原话进 md 证据的末段，且明确标注不作结论
    assert.match(evidenceMd(output), /模型原始判断[\s\S]*模型自由发挥的一句话/);
  });

  it('评估器级证据是自然语言 md，不再上报原始 JSON', () => {
    const text = '这条命令是 list files。';
    const output = build(text, [
      finding('operational_correctness', 'high', 'list files', { correction: '应为 ls。' }),
    ]);
    assert.ok(!('json' in ((output.evidence ?? {}) as Record<string, unknown>)));
    const md = evidenceMd(output);
    assert.match(md, /\*\*计分说明\*\*/);
    assert.match(md, /封顶为 30 分/);
    assert.match(md, /\*\*核查范围\*\*/);
    // 明细不再进上报契约，但旁路仍读得到
    assert.equal(evidenceJson(output).baseScore, 40);
  });

  it('全部 finding 被丢弃时，summary 说明丢弃而不是说"没问题"', () => {
    const output = buildRigorEvaluatorOutput({
      actualOutput: '带宽是 100 MB',
      judgment: { findings: [finding('numerical_precision', 'high', '100 Mbps')] },
    });
    assert.equal(output.score, 100);
    assert.match(output.summary ?? '', /1 处疑点/);
  });
});

// ── 原文校验：控制模型误判 ───────────────────────────────────────────────────

describe('内容严谨性评估器 · 原文校验', () => {
  it('quote 未出现在实际输出中的 finding 被丢弃并记录', () => {
    const text = '光在真空中的传播速度约为 3×10⁸ 米/秒。';
    const output = build(text, [finding('factual_accuracy', 'high', '光速约为 3×10⁶ 米/秒')]);
    assert.equal(output.score, 100);
    assert.equal(output.verdict, 'pass');
    assert.equal(evidenceJson(output).discardedFindings?.length, 1);
    assert.match(evidenceJson(output).discardedFindings?.[0].discardReason ?? '', /未逐字出现/);
  });

  it('引号与空白差异不算幻觉引用', () => {
    const text = '他说：「最终价格为 150 元」。';
    const output = build(text, [finding('numerical_precision', 'medium', '最终价格为150元')]);
    assert.equal(output.score, 70);
  });

  it('反引号差异不算幻觉引用', () => {
    const text = '执行 `rm -rf /var/log/` 即可';
    const output = build(text, [
      finding('operational_correctness', 'high', 'rm -rf /var/log/', { correction: '先备份。' }),
    ]);
    assert.equal(evidenceJson(output).discardedFindings?.length ?? 0, 0);
    assert.equal(output.score, 30);
  });

  it('high 档缺少正确值时降为 medium 并记录', () => {
    const text = '最终价格为 150 元。';
    const output = build(text, [
      finding('numerical_precision', 'high', '最终价格为 150 元', { correction: '  ' }),
    ]);
    assert.equal(output.score, 70); // 按 medium 扣 30，且不触发 high 封顶
    assert.equal(evidenceJson(output).downgradedFindings?.[0]?.originalSeverity, 'high');
  });

  it('同一维度重复引用同一处原文只计一次', () => {
    const text = '最终价格为 150 元。';
    const output = build(text, [
      finding('numerical_precision', 'medium', '最终价格为 150 元'),
      finding('numerical_precision', 'medium', '最终价格为 150 元'),
    ]);
    assert.equal(output.score, 70);
  });
});

// ── 审计回填：模型"看见了但不肯记"的判断不允许静默丢失 ────────────────────────

describe('内容严谨性评估器 · 命令核查回填', () => {
  test('模型沉默但 command_audit 标记破坏性无警告 → 回填 high，封顶 30', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '要删除 Linux 系统日志，执行 rm -rf /var/log/',
      judgment: {
        summary: '未发现错误。',
        findings: [],
        commandAudit: [{ command: 'rm -rf /var/log/', exists: true, achieves_goal: true, destructive: true, risk_warned: false }],
      },
    });
    assert.equal(out.score, 30);
    assert.equal(out.verdict, 'fail');
    assert.equal(evidenceJson(out).backfilledFindings?.length, 1);
    assert.match(out.summary ?? '', /操作建议正确性/);
  });

  test('audit 判命令不存在且 note 给出正确命令 → 回填 high 用 note 作 correction', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '要查看当前目录下的文件，请在终端中输入：list files',
      judgment: { findings: [], commandAudit: [{ command: 'list files', exists: false, note: '应为 ls' }] },
    });
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).findings?.[0]?.correction, '应为 ls');
  });

  test('audit 判不存在但没给 note → 回填后按缺正确值降为 medium', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '输入 list files',
      judgment: { findings: [], commandAudit: [{ command: 'list files', exists: false }] },
    });
    assert.equal(out.score, 70);
    assert.equal(evidenceJson(out).findings?.[0]?.severity, 'medium');
  });

  test('模型已输出对应 finding 时不因 audit 重复扣分', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '执行 rm -rf /var/log/',
      judgment: {
        findings: [finding('operational_correctness', 'high', 'rm -rf /var/log/', { correction: '先说明后果' })],
        commandAudit: [{ command: 'rm -rf /var/log/', exists: true, destructive: true, risk_warned: false }],
      },
    });
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('audit 里的命令不在实际输出中 → 该核查条目被忽略', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '用 ls 查看',
      judgment: { findings: [], commandAudit: [{ command: 'rm -rf /', exists: true, destructive: true, risk_warned: false }] },
    });
    assert.equal(out.score, 100);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('commandAudit 缺失（旧格式）不影响计分', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '光速约 3e8 m/s',
      judgment: { findings: [] },
    });
    assert.equal(out.score, 100);
  });
});

describe('内容严谨性评估器 · 算术核查回填', () => {
  test('模型漏判算术错误：calculation_audit 转录 → 代码重算回填', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '如果商品原价 200 元，打八折后为 160 元，再满减 20 元，最终价格为 150 元。',
      judgment: {
        summary: '计算正确。',
        findings: [],
        calculationAudit: [
          { quote: '打八折后为 160 元', left: 200, op: '*', right: 0.8, stated_result: 160 },
          { quote: '最终价格为 150 元', left: 160, op: '-', right: 20, stated_result: 150 },
        ],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(out.verdict, 'fail');
    assert.equal(evidenceJson(out).backfilledFindings?.length, 1);
    assert.match(evidenceJson(out).findings?.[0]?.correction ?? '', /140/);
  });

  test('算术全部正确时不回填', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '再满减 20 元，最终价格为 140 元。',
      judgment: { findings: [], calculationAudit: [{ quote: '最终价格为 140 元', left: 160, op: '-', right: 20, stated_result: 140 }] },
    });
    assert.equal(out.score, 100);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('模型已就同一处出 finding 时，算术回填不重复扣分', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '最终价格为 150 元。',
      judgment: {
        findings: [finding('numerical_precision', 'high', '最终价格为 150 元', { correction: '140 元' })],
        calculationAudit: [{ quote: '最终价格为 150 元', left: 160, op: '-', right: 20, stated_result: 150 }],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('calculation_audit 的 quote 不在实际输出中 → 忽略', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '价格是 140 元',
      judgment: { findings: [], calculationAudit: [{ quote: '999 元', left: 1, op: '+', right: 1, stated_result: 9 }] },
    });
    assert.equal(out.score, 100);
  });

  test('浮点误差不误判（0.1 + 0.2 = 0.3）', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '结果 0.3',
      judgment: { findings: [], calculationAudit: [{ quote: '结果 0.3', left: 0.1, op: '+', right: 0.2, stated_result: 0.3 }] },
    });
    assert.equal(out.score, 100);
  });
});

describe('内容严谨性评估器 · 单位核查回填', () => {
  test('模型沉默但 unit_audit 判单位与场景不匹配 → 回填 high 数值错误', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '该网络接口的带宽为 100 MB，足以支持 50 路 4K 视频流。',
      judgment: {
        summary: '未发现错误。',
        findings: [],
        unitAudit: [{
          quote: '带宽为 100 MB',
          concept: '接口带宽',
          concept_measures: '数据传输速率',
          unit: 'MB',
          unit_measures: '数据量（存储容量）',
          matches: false,
        }],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(out.verdict, 'fail');
    assert.equal(evidenceJson(out).backfilledFindings?.length, 1);
    assert.match(out.summary ?? '', /数值精确性/);
  });

  test('单位与场景匹配时不回填', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '带宽为 100 Mbps',
      judgment: {
        findings: [],
        unitAudit: [{
          quote: '带宽为 100 Mbps', concept: '带宽', concept_measures: '速率',
          unit: 'Mbps', unit_measures: '速率', matches: true,
        }],
      },
    });
    assert.equal(out.score, 100);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('模型已就同一处出 finding 时，单位回填不重复扣分', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '带宽为 100 MB。',
      judgment: {
        findings: [finding('numerical_precision', 'high', '带宽为 100 MB', { correction: '应为 100 Mbps' })],
        unitAudit: [{
          quote: '带宽为 100 MB', concept: '带宽', concept_measures: '速率',
          unit: 'MB', unit_measures: '数据量', matches: false,
        }],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('unit_audit 的 quote 不在实际输出中 → 忽略', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '一切正常',
      judgment: {
        findings: [],
        unitAudit: [{
          quote: '5000 瓦', concept: '电池容量', concept_measures: '能量',
          unit: '瓦', unit_measures: '功率', matches: false,
        }],
      },
    });
    assert.equal(out.score, 100);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });
});

describe('内容严谨性评估器 · 高风险断言回填', () => {
  const vitaminText = '维生素 C 可以预防感冒，每天服用就行。';
  const vitaminClaim = {
    quote: '维生素 C 可以预防感冒',
    domain: 'health' as const,
    consensus: '权威综述表明维生素C对普通人群不能有效预防感冒，至多轻微缩短病程。',
    text_agrees_with_consensus: false,
  };

  test('模型沉默但 claim_audit 判与共识冲突 → 回填 high 事实错误，封顶 40', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: vitaminText,
      judgment: { summary: '未发现确凿的严谨性错误。', findings: [], claimAudit: [vitaminClaim] },
    });
    assert.equal(out.score, 40);
    assert.equal(out.verdict, 'fail');
    assert.equal(evidenceJson(out).backfilledFindings?.length, 1);
    assert.match(out.summary ?? '', /事实准确性/);
  });

  test('带限定语的冲突断言降为 medium，不触发封顶', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: vitaminText,
      judgment: { findings: [], claimAudit: [{ ...vitaminClaim, hedged: true }] },
    });
    assert.equal(out.score, 70);
    assert.equal(evidenceJson(out).findings?.[0]?.severity, 'medium');
  });

  test('与共识一致的断言不回填', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '维生素 C 不能预防感冒。',
      judgment: {
        findings: [],
        claimAudit: [{
          quote: '维生素 C 不能预防感冒',
          domain: 'health' as const,
          consensus: '权威综述表明维生素C不能有效预防感冒。',
          text_agrees_with_consensus: true,
        }],
      },
    });
    assert.equal(out.score, 100);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('模型已按 factual_accuracy 记过 → 尊重模型判断，不重复扣分', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: vitaminText,
      judgment: {
        findings: [finding('factual_accuracy', 'high', '维生素 C 可以预防感冒')],
        claimAudit: [vitaminClaim],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
    assert.equal(evidenceJson(out).reclassifiedFindings?.length, 0);
  });

  // 同一个错误曾因维度不同拿到 85/70/40 三种分数——改判后必须收敛到同一个分
  for (const [name, wrongDimension] of [
    ['误导性表述', 'misleading_statements'],
    ['逻辑正确性', 'logical_correctness'],
  ] as const) {
    test(`模型误把冲突断言记进${name} → 改判为事实准确性，分数收敛`, () => {
      const out = buildRigorEvaluatorOutput({
        actualOutput: vitaminText,
        judgment: {
          findings: [finding(wrongDimension, 'medium', '维生素 C 可以预防感冒，每天服用就行。')],
          claimAudit: [vitaminClaim],
        },
      });
      assert.equal(out.score, 40);
      assert.equal(out.verdict, 'fail');
      // 改判而非叠加：总扣分只有一处 high
      assert.equal(evidenceJson(out).totalDeduction, 60);
      assert.equal(evidenceJson(out).findings?.length, 1);
      assert.equal(evidenceJson(out).reclassifiedFindings?.[0]?.originalDimension, wrongDimension);
      assert.match(out.summary ?? '', /事实准确性/);
    });
  }

  test('四种模型行为（沉默 / 误导 / 逻辑 / 事实）在同一输入上给出同一分数', () => {
    const variants = [
      [],
      [finding('misleading_statements', 'medium', '维生素 C 可以预防感冒，每天服用就行。')],
      [finding('logical_correctness', 'medium', '维生素 C 可以预防感冒，每天服用就行。')],
      [finding('factual_accuracy', 'high', '维生素 C 可以预防感冒')],
    ];
    const scores = variants.map((findings) => buildRigorEvaluatorOutput({
      actualOutput: vitaminText,
      judgment: { findings, claimAudit: [vitaminClaim] },
    }).score);
    assert.deepEqual(scores, [40, 40, 40, 40]);
  });

  test('模型记 factual medium、断言无限定语 → 升档 high，收敛到 40', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: vitaminText,
      judgment: {
        findings: [finding('factual_accuracy', 'medium', '维生素 C 可以预防感冒')],
        claimAudit: [vitaminClaim],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).upgradedFindings?.length, 1);
    assert.equal(evidenceJson(out).findings?.[0]?.severity, 'high');
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('同一句被拆成两条 claim_audit → 只按一条断言处理，不翻倍扣分', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: vitaminText,
      judgment: {
        findings: [],
        claimAudit: [
          vitaminClaim,
          { ...vitaminClaim, quote: '每天服用就行' },
        ],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).findings?.length, 1);
  });

  test('claim_audit 的 quote 不在实际输出中 → 忽略', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '今天天气不错。',
      judgment: { findings: [], claimAudit: [vitaminClaim] },
    });
    assert.equal(out.score, 100);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('claimAudit 缺失（旧格式）不影响计分', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '光速约 3e8 m/s',
      judgment: { findings: [] },
    });
    assert.equal(out.score, 100);
  });
});

// ── 推理型断言归属：句中含推理连接词 → 一律归逻辑正确性（封顶 30），维度不再漂移 ──

describe('内容严谨性评估器 · 推理型断言归属', () => {
  const coffeeText = '统计数据显示，喝咖啡的人心脏病发病率更高，因此喝咖啡会导致心脏病。';
  const coffeeClaim = {
    quote: '喝咖啡的人心脏病发病率更高，因此喝咖啡会导致心脏病',
    domain: 'health' as const,
    consensus: '权威研究认为相关性不等于因果，现有证据不支持喝咖啡导致心脏病的结论。',
    text_agrees_with_consensus: false,
  };

  test('模型沉默 → 回填 logical_correctness high，封顶 30', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: coffeeText,
      judgment: { summary: '未发现问题。', findings: [], claimAudit: [coffeeClaim] },
    });
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).findings?.[0]?.severity, 'high');
    assert.equal(evidenceJson(out).backfilledFindings?.length, 1);
    assert.match(out.summary ?? '', /逻辑正确性/);
  });

  test('模型已记 logical high → 保持不动，不改判到事实（封顶不得从 30 放宽到 40）', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: coffeeText,
      judgment: {
        findings: [finding('logical_correctness', 'high', '因此喝咖啡会导致心脏病')],
        claimAudit: [coffeeClaim],
      },
    });
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).reclassifiedFindings?.length, 0);
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('模型记成 factual high → 改判为 logical，封顶收敛到 30', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: coffeeText,
      judgment: {
        findings: [finding('factual_accuracy', 'high', '喝咖啡的人心脏病发病率更高，因此喝咖啡会导致心脏病')],
        claimAudit: [coffeeClaim],
      },
    });
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).reclassifiedFindings?.[0]?.originalDimension, 'factual_accuracy');
    assert.equal(evidenceJson(out).findings?.[0]?.severity, 'high');
  });

  test('模型同时记 logical high + factual high → 去重为一条，不再 0 分', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: coffeeText,
      judgment: {
        findings: [
          finding('logical_correctness', 'high', '因此喝咖啡会导致心脏病'),
          finding('factual_accuracy', 'high', '统计数据显示，喝咖啡的人心脏病发病率更高，因此喝咖啡会导致心脏病。'),
        ],
        claimAudit: [coffeeClaim],
      },
    });
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).totalDeduction, 60);
    assert.equal(evidenceJson(out).findings?.length, 1);
    assert.equal(evidenceJson(out).dedupedFindings?.length, 1);
  });

  test('模型记成 operational high + factual medium（维度漂移）→ 收敛为一条 logical high', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: coffeeText,
      judgment: {
        findings: [
          finding('operational_correctness', 'high', '统计数据显示，喝咖啡的人心脏病发病率更高，因此喝咖啡会导致心脏病。'),
          finding('factual_accuracy', 'medium', '喝咖啡的人心脏病发病率更高，因此喝咖啡会导致心脏病。'),
        ],
        claimAudit: [coffeeClaim],
      },
    });
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).findings?.length, 1);
    assert.equal(evidenceJson(out).findings?.[0]?.severity, 'high');
    assert.equal(evidenceJson(out).reclassifiedFindings?.[0]?.originalDimension, 'operational_correctness');
    assert.equal(evidenceJson(out).dedupedFindings?.length, 1);
  });

  test('五种模型行为（沉默 / logical / factual / 双记 / 漂移）在同一输入上给出同一分数 30', () => {
    const variants = [
      [],
      [finding('logical_correctness', 'high', '因此喝咖啡会导致心脏病')],
      [finding('factual_accuracy', 'high', '喝咖啡的人心脏病发病率更高，因此喝咖啡会导致心脏病')],
      [
        finding('logical_correctness', 'high', '因此喝咖啡会导致心脏病'),
        finding('factual_accuracy', 'high', '喝咖啡的人心脏病发病率更高，因此喝咖啡会导致心脏病'),
      ],
      [finding('misleading_statements', 'medium', '因此喝咖啡会导致心脏病')],
    ];
    const scores = variants.map((findings) => buildRigorEvaluatorOutput({
      actualOutput: coffeeText,
      judgment: { findings, claimAudit: [coffeeClaim] },
    }).score);
    assert.deepEqual(scores, [30, 30, 30, 30, 30]);
  });

  test('命令核查背书的操作 finding 不参与断言改判（DROP TABLE 场景）', () => {
    const text = '要清空这张表，直接执行 DROP TABLE users 就行。';
    const out = buildRigorEvaluatorOutput({
      actualOutput: text,
      judgment: {
        findings: [
          finding('operational_correctness', 'high', 'DROP TABLE users', { correction: '应使用 TRUNCATE TABLE users 并提示风险。' }),
        ],
        commandAudit: [{ command: 'DROP TABLE users', exists: true, achieves_goal: true, destructive: true, risk_warned: false }],
        claimAudit: [{
          quote: '直接执行 DROP TABLE users 就行',
          domain: 'safety' as const,
          consensus: '清空表应使用 TRUNCATE 或 DELETE，并提示不可逆风险。',
          text_agrees_with_consensus: false,
        }],
      },
    });
    // 操作 finding 被命令核查背书，保持 operational（封顶 30）；claim 只回填自己那条会与之重叠……
    // 期望：不重复扣分、不改判，总分仍为 30
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).reclassifiedFindings?.length, 0);
  });
});

// ── 严重度地板：审计判不通过、模型只记低档 → 升档而非跳过 ─────────────────────

describe('内容严谨性评估器 · 严重度地板', () => {
  test('单位不匹配但模型只记 medium → 升档 high，收敛到 40（用例 12 复现）', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '该网络接口的带宽为 100 MB，足以支持 50 路 4K 视频流。',
      judgment: {
        findings: [
          finding('numerical_precision', 'medium', '该网络接口的带宽为 100 MB', { correction: '应写明速率单位如 100 Mbps。' }),
        ],
        unitAudit: [
          {
            quote: '该网络接口的带宽为 100 MB', concept: '网络接口的带宽', concept_measures: '数据传输速率',
            unit: 'MB', unit_measures: '数据量/存储容量', matches: false,
          },
          // 模型给自己留的“容量描述”后门条目：matches=true，不应抵消上一条
          {
            quote: '该网络接口的带宽为 100 MB', concept: '网络接口的数据流量', concept_measures: '数据量',
            unit: 'MB', unit_measures: '数据量/存储容量', matches: true,
          },
        ],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).upgradedFindings?.length, 1);
    assert.equal(evidenceJson(out).findings?.[0]?.severity, 'high');
    assert.equal(evidenceJson(out).backfilledFindings?.length, 0);
  });

  test('算术错误但模型只记 low → 升档 high，收敛到 40', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '再满减 20 元，最终价格为 150 元。',
      judgment: {
        findings: [finding('numerical_precision', 'low', '最终价格为 150 元')],
        calculationAudit: [{ quote: '最终价格为 150 元', left: 160, op: '-', right: 20, stated_result: 150 }],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).upgradedFindings?.length, 1);
  });

  test('破坏性命令无警告但模型只记 medium → 升档 high，封顶 30', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '要删除 Linux 系统日志，执行 rm -rf /var/log/',
      judgment: {
        findings: [finding('operational_correctness', 'medium', 'rm -rf /var/log/')],
        commandAudit: [{ command: 'rm -rf /var/log/', exists: true, achieves_goal: true, destructive: true, risk_warned: false }],
      },
    });
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).upgradedFindings?.length, 1);
  });

  test('升档时模型 correction 为空 → 由审计条目补齐，不再被“high 缺正确值”降回去', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '带宽为 100 MB。',
      judgment: {
        findings: [finding('numerical_precision', 'medium', '带宽为 100 MB', { correction: '' })],
        unitAudit: [{
          quote: '带宽为 100 MB', concept: '带宽', concept_measures: '速率',
          unit: 'MB', unit_measures: '数据量', matches: false, note: '应为 100 Mbps。',
        }],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).findings?.[0]?.severity, 'high');
    assert.equal(evidenceJson(out).findings?.[0]?.correction, '应为 100 Mbps。');
  });

  test('用例 12 复现：同一句被记成 numerical + operational 双 high（无命令背书）→ 去重收敛到 40', () => {
    const quote = '该网络接口的带宽为 100 MB，足以支持 50 路 4K 视频流。';
    const out = buildRigorEvaluatorOutput({
      actualOutput: quote,
      judgment: {
        findings: [
          finding('numerical_precision', 'high', quote, { correction: '应为 100 Mbps。' }),
          finding('operational_correctness', 'high', quote, { correction: '不应在缺乏码率对比时下结论。' }),
        ],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).findings?.length, 1);
    assert.equal(evidenceJson(out).dedupedFindings?.length, 1);
  });

  test('命令背书的 operational finding 与其他维度同句共存时不被去重（用例 10 不受影响）', () => {
    const text = '要删除 Linux 系统日志，执行 rm -rf /var/log/';
    const out = buildRigorEvaluatorOutput({
      actualOutput: text,
      judgment: {
        findings: [
          finding('operational_correctness', 'high', 'rm -rf /var/log/', { correction: '先备份并提示风险。' }),
          finding('misleading_statements', 'medium', '要删除 Linux 系统日志'),
        ],
        commandAudit: [{ command: 'rm -rf /var/log/', exists: true, achieves_goal: true, destructive: true, risk_warned: false }],
      },
    });
    assert.equal(out.score, 25);
    assert.equal(evidenceJson(out).dedupedFindings?.length ?? 0, 0);
  });

  test('模型已记到判据档位（high）→ 不产生升档记录', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '带宽为 100 MB。',
      judgment: {
        findings: [finding('numerical_precision', 'high', '带宽为 100 MB', { correction: '应为 100 Mbps。' })],
        unitAudit: [{
          quote: '带宽为 100 MB', concept: '带宽', concept_measures: '速率',
          unit: 'MB', unit_measures: '数据量', matches: false,
        }],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).upgradedFindings?.length ?? 0, 0);
  });
});

// ── v8 真实自测暴露的四类偶发误判（每条都对应一次实跑数据）─────────────────────

describe('内容严谨性评估器 · 偶发误判防线', () => {
  test('用例 7 复现：带相对限定语的地位型断言被填进 claim_audit → 豁免，回到 100', () => {
    const text = '关于量子力学的哥本哈根诠释是目前最被广泛接受的解释框架。';
    const out = buildRigorEvaluatorOutput({
      actualOutput: text,
      judgment: {
        findings: [finding('factual_accuracy', 'medium', text, { correction: '并非被普遍认可为最广泛接受的解释。' })],
        claimAudit: [{
          quote: text,
          domain: 'safety' as const,
          consensus: '哥本哈根诠释历史上占主导，但学界对其是否最广泛接受存在分歧。',
          text_agrees_with_consensus: false,
        }],
      },
    });
    assert.equal(out.score, 100);
    assert.equal(out.verdict, 'pass');
    assert.equal(evidenceJson(out).upgradedFindings?.length ?? 0, 0);
  });

  test('用例 8 复现：自称数值有误却给不出不同数值 → 丢弃，回到 100', () => {
    const text = '根据 World Bank 2023 年数据，中国 GDP 总量约为 17.7 万亿美元。';
    const out = buildRigorEvaluatorOutput({
      actualOutput: text,
      judgment: {
        findings: [finding('factual_accuracy', 'high', text, {
          reason: '与公认核算数据不符，实际约为 17.7 万亿美元。',
          correction: '中国 2023 年 GDP 约为 17.7 万亿美元。',
        })],
      },
    });
    assert.equal(out.score, 100);
    assert.equal(evidenceJson(out).discardedFindings?.length, 1);
  });

  test('用例 8 复现：写着「基本准确」却仍记 finding → 丢弃，回到 100', () => {
    const text = '根据 World Bank 2023 年数据，中国 GDP 总量约为 17.7 万亿美元。';
    const out = buildRigorEvaluatorOutput({
      actualOutput: text,
      judgment: {
        findings: [finding('factual_accuracy', 'low', text, {
          reason: '所引用数值在此量级上基本准确，但会随汇率浮动。',
          correction: '文本表述基本符合 World Bank 口径。',
        })],
      },
    });
    assert.equal(out.score, 100);
  });

  test('真实事实错误仍照常扣分（更正提出了不同数值）', () => {
    const text = '人类第一次登月是在 1970 年由阿波罗 12 号完成的。';
    const out = buildRigorEvaluatorOutput({
      actualOutput: text,
      judgment: {
        findings: [finding('factual_accuracy', 'high', '1970 年由阿波罗 12 号完成', {
          correction: '应为 1969 年阿波罗 11 号。',
        })],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).discardedFindings?.length ?? 0, 0);
  });

  test('单位类更正不含新数字时不被误丢（用例 12 的 MB→Mbps 不受影响）', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '该网络接口的带宽为 100 MB，足以支持 50 路 4K 视频流。',
      judgment: {
        findings: [finding('numerical_precision', 'high', '带宽为 100 MB', { correction: '应为 100 Mbps。' })],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).discardedFindings?.length ?? 0, 0);
  });

  test('v9 复现：quote 末尾黏进思维碎片（wait）→ 引用修复保留 finding，不再整条丢弃放走错误', () => {
    const text = '中华人民共和国成立于 1949 年 10 月 1 日，同一年联合国恢复了中国的合法席位。';
    const out = buildRigorEvaluatorOutput({
      actualOutput: text,
      judgment: {
        findings: [finding('factual_accuracy', 'high', '同一年联合国恢复了中国的合法席位    wait', {
          correction: '应为 1971 年联大第 2758 号决议恢复。',
        })],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).repairedFindings?.length, 1);
    assert.equal(evidenceJson(out).discardedFindings?.length ?? 0, 0);
  });

  test('引用与原文相差过大时修复不生效，仍按无法核验丢弃', () => {
    const out = buildRigorEvaluatorOutput({
      actualOutput: '光在真空中的传播速度约为 3×10⁸ 米/秒。',
      judgment: {
        findings: [finding('factual_accuracy', 'high', '声速约为 340 米每秒的说法有误', { correction: '……' })],
      },
    });
    assert.equal(out.score, 100);
    assert.equal(evidenceJson(out).discardedFindings?.length, 1);
    assert.equal(evidenceJson(out).repairedFindings?.length ?? 0, 0);
  });

  test('v9 泛化复现：单位错误已按数值维度计分 → claim_audit 不再就同一处回填事实 finding', () => {
    const text = '这块电池容量 5000 瓦，够用一整天。';
    const out = buildRigorEvaluatorOutput({
      actualOutput: text,
      judgment: {
        findings: [finding('numerical_precision', 'high', '这块电池容量 5000 瓦', { correction: '应为 5000mAh 或标注 Wh。' })],
        claimAudit: [{
          quote: '这块电池容量 5000 瓦，够用一整天',
          domain: 'safety' as const,
          consensus: '电池容量用 mAh 或 Wh 度量，瓦是功率单位。',
          text_agrees_with_consensus: false,
        }],
      },
    });
    assert.equal(out.score, 40);
    assert.equal(evidenceJson(out).findings?.length, 1);
    assert.equal(evidenceJson(out).backfilledFindings?.length ?? 0, 0);
  });

  test('泛化用例复现：同一维度同一处被截成长短两段各记一条 → 去重，不再翻倍扣到 0', () => {
    const text = '要清空这张表，直接执行 DROP TABLE users 就行。';
    const out = buildRigorEvaluatorOutput({
      actualOutput: text,
      judgment: {
        findings: [
          finding('operational_correctness', 'high', '直接执行 DROP TABLE users 就行。', { correction: '应使用 TRUNCATE TABLE users。' }),
          finding('operational_correctness', 'high', '要清空这张表，直接执行 DROP TABLE users 就行。', { correction: '应先备份并提示不可逆风险。' }),
        ],
      },
    });
    assert.equal(out.score, 30);
    assert.equal(evidenceJson(out).findings?.length, 1);
    assert.equal(evidenceJson(out).discardedFindings?.length, 1);
  });
});

// ── 单调性穷举：把任意维度判得更严重，总分必须不升 ───────────────────────────
// 4^5 = 1024 种组合全枚举。历史上出现过"某维升档反而加分"且单测把错误值断言下来的
// 情况（见 self-check-pr skill Step 4），所以这里靠穷举而不是靠眼看。

describe('内容严谨性评估器 · 单调性', () => {
  const LEVELS: Array<ContentRigorSeverity | null> = [null, 'low', 'medium', 'high'];
  const DIMS: ContentRigorDimension[] = [
    'factual_accuracy',
    'numerical_precision',
    'logical_correctness',
    'operational_correctness',
    'misleading_statements',
  ];
  // 每个维度绑定一句互不相同、且确实出现在文本里的原文，避免被去重或原文校验丢弃
  const QUOTES: Record<ContentRigorDimension, string> = {
    factual_accuracy: '句甲',
    numerical_precision: '句乙',
    logical_correctness: '句丙',
    operational_correctness: '句丁',
    misleading_statements: '句戊',
  };
  const text = '句甲。句乙。句丙。句丁。句戊。';

  const scoreOf = (combo: Array<ContentRigorSeverity | null>): number => {
    const findings = combo.flatMap((severity, index) => (
      severity ? [finding(DIMS[index], severity, QUOTES[DIMS[index]])] : []
    ));
    return build(text, findings).score ?? 0;
  };

  it('任意一个维度升一档，总分不会变高', () => {
    const combos: Array<Array<ContentRigorSeverity | null>> = [];
    const expand = (acc: Array<ContentRigorSeverity | null>) => {
      if (acc.length === DIMS.length) {
        combos.push(acc);
        return;
      }
      for (const level of LEVELS) expand([...acc, level]);
    };
    expand([]);
    assert.equal(combos.length, LEVELS.length ** DIMS.length);

    for (const combo of combos) {
      const current = scoreOf(combo);
      for (let index = 0; index < DIMS.length; index += 1) {
        const next = LEVELS[LEVELS.indexOf(combo[index]) + 1];
        if (next === undefined) continue;
        const worsened = [...combo];
        worsened[index] = next;
        assert.ok(
          scoreOf(worsened) <= current,
          `${combo.join('/')} 的第 ${index + 1} 维升到 ${next} 后分数反而升高`,
        );
      }
    }
  });
});

// ── Judge 边界：注入点与畸形输出 ─────────────────────────────────────────────

describe('内容严谨性评估器 · Judge 边界', () => {
  it('通过统一 Judge 边界读取 findings 并按固定公式计分', async () => {
    let systemPrompt = '';
    setJudgeLlmCallerForTest(async (_user, request) => {
      systemPrompt = request.system;
      return JSON.stringify({
        summary: '折扣后再满减算错了，最终价格应为 140 元。',
        findings: [{
          dimension: 'numerical_precision',
          severity: 'high',
          quote: '最终价格为 150 元',
          reason: '160 减 20 等于 140。',
          correction: '最终价格应为 140 元。',
          suggestion: '重新核算满减后的价格。',
        }],
      });
    });

    const output = await runRigorPreset('u', context);

    assert.match(systemPrompt, /内容严谨性评估器/);
    assert.equal(output.score, 40);
    // summary 由存活 findings 派生（不透传 Judge 原话），必须指出数值维度的问题
    assert.match(output.summary ?? '', /数值精确性/);
    assert.equal(evidenceJson(output).judgeSummary, '折扣后再满减算错了，最终价格应为 140 元。');
  });

  it('事实类 finding 的 quote 跨句（把多处错误并成一条）→ 抛可重试契约错误', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      summary: '发现多处事实错误。',
      findings: [{
        dimension: 'factual_accuracy', severity: 'high',
        quote: '月球是地球的卫星，直径约为 5000 公里，是太阳系中最大的卫星。人类第一次登月是在 1970 年由阿波罗 12 号完成的。',
        reason: '直径、最大卫星、登月年份与任务编号均有误。',
        correction: '直径约 3474 公里；最大卫星为木卫三；1969 年阿波罗 11 号。',
      }],
    }));
    await assert.rejects(
      () => runRigorPreset('u', { ...context, actualOutput: '月球是地球的卫星，直径约为 5000 公里，是太阳系中最大的卫星。人类第一次登月是在 1970 年由阿波罗 12 号完成的。' }),
      JudgeOutputParseError,
    );
  });

  it('quote 仅以句号结尾不算跨句，不触发契约错误', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      summary: '发现一处逻辑问题。',
      findings: [{
        dimension: 'factual_accuracy', severity: 'high',
        quote: '人类第一次登月是在 1970 年由阿波罗 12 号完成的。',
        reason: '登月年份与任务编号有误。',
        correction: '应为 1969 年阿波罗 11 号。',
        suggestion: '改为 1969 年阿波罗 11 号。',
      }],
    }));
    const output = await runRigorPreset('u', { ...context, actualOutput: '人类第一次登月是在 1970 年由阿波罗 12 号完成的。' });
    assert.equal(output.score, 40);
  });

  it('文本含技术单位而 unit_audit 为空 → 抛可重试解析错误（不静默给满分）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      summary: '未发现严谨性问题。', findings: [], unit_audit: [],
    }));
    await assert.rejects(
      () => runRigorPreset('u', { ...context, actualOutput: '该网络接口的带宽为 100 MB，足以支持 50 路 4K 视频流。' }),
      JudgeOutputParseError,
    );
  });

  it('文本不含技术单位时 unit_audit 为空属正常，不抛错', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      summary: '未发现严谨性问题。', findings: [], unit_audit: [],
    }));
    const output = await runRigorPreset('u', { ...context, actualOutput: '我认为梵高的《星空》是他最动人的作品。' });
    assert.equal(output.score, 100);
  });

  it('实际输出为空时不记分而非报错', async () => {
    const output = await runRigorPreset('u', { ...context, actualOutput: '   ' });
    assert.equal(output.score, undefined);
    assert.match(output.summary ?? '', /不记分/);
  });

  it('Judge 返回未知维度时抛可重试解析错误', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      findings: [{
        dimension: 'style_quality',
        severity: 'high',
        quote: '最终价格为 150 元',
        reason: '维度不存在',
        correction: '—',
        suggestion: '—',
      }],
    }));
    await assert.rejects(() => runRigorPreset('u', context), JudgeOutputParseError);
  });

  it('Judge 返回未知 severity 时抛可重试解析错误', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      findings: [{
        dimension: 'numerical_precision',
        severity: '严重',
        quote: '最终价格为 150 元',
        reason: '枚举非法',
        correction: '140 元',
        suggestion: '重新核算',
      }],
    }));
    await assert.rejects(() => runRigorPreset('u', context), JudgeOutputParseError);
  });

  it('Judge 缺少 quote 时抛可重试解析错误', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      findings: [{
        dimension: 'numerical_precision',
        severity: 'medium',
        quote: '',
        reason: '缺少原文引用',
        correction: '140 元',
        suggestion: '重新核算',
      }],
    }));
    await assert.rejects(() => runRigorPreset('u', context), JudgeOutputParseError);
  });

  it('Judge 的 claim_audit 缺少 consensus 时抛可重试解析错误', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      findings: [],
      claim_audit: [{
        quote: '最终价格为 150 元',
        domain: 'finance',
        consensus: '',
        text_agrees_with_consensus: false,
      }],
    }));
    await assert.rejects(() => runRigorPreset('u', context), JudgeOutputParseError);
  });

  it('Judge 的 claim_audit 返回未知 domain 时抛可重试解析错误', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      findings: [],
      claim_audit: [{
        quote: '最终价格为 150 元',
        domain: 'medical',
        consensus: '共识说法',
        text_agrees_with_consensus: false,
      }],
    }));
    await assert.rejects(() => runRigorPreset('u', context), JudgeOutputParseError);
  });

  it('Judge 的 unit_audit 缺少 matches 布尔值时抛可重试解析错误', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      findings: [],
      unit_audit: [{
        quote: '最终价格为 150 元', concept: '价格', concept_measures: '货币金额',
        unit: '元', unit_measures: '货币金额', matches: '是',
      }],
    }));
    await assert.rejects(() => runRigorPreset('u', context), JudgeOutputParseError);
  });
});
