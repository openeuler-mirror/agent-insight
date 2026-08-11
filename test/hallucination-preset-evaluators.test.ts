/** 文本幻觉检测评估器（HallucinationGrader）的 Judge 契约与确定性计分测试。 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import {
  HALLUCINATION_PRESET_IDS,
  buildHallucinationOutput,
  isHallucinationPresetId,
  runHallucinationPreset,
  type HallucinationFinding,
} from '@/lib/engine/experiment/hallucination-preset-evaluators';
import type { FaithfulPresetContext } from '@/lib/engine/experiment/faithful-preset-evaluators';

/** 拉开占比的填充文本：quote + 100 个「佐」→ 占比稳定落入 <10% 档（占比加权固定扣 5）。 */
const PAD = '佐'.repeat(100);

function makeContext(overrides: Partial<FaithfulPresetContext> = {}): FaithfulPresetContext {
  return {
    caseInput: '请评估以下回答是否包含虚构内容',
    actualOutput: '',
    referenceOutput: null,
    traceSummaryText: null,
    interactions: [],
    taskId: null,
    executionId: null,
    ...overrides,
  };
}

function evidenceMd(point?: { evidence?: unknown }): string {
  return (point?.evidence as { md?: string } | undefined)?.md ?? '';
}

afterEach(() => setJudgeLlmCallerForTest(null));

describe('幻觉检测预置评估器', () => {
  describe('导出契约', () => {
    it('HALLUCINATION_PRESET_IDS / isHallucinationPresetId', () => {
      assert.deepEqual(HALLUCINATION_PRESET_IDS, ['preset-hallucination-text']);
      assert.equal(isHallucinationPresetId('preset-hallucination-text'), true);
      assert.equal(isHallucinationPresetId('preset-fluency-text'), false);
      assert.equal(isHallucinationPresetId('preset-depth-result'), false);
    });
  });

  describe('纯函数 buildHallucinationOutput 计分边界', () => {
    it('无幻觉 → 100 分，五维度全 covered', () => {
      const output = buildHallucinationOutput(
        { hallucinations: [], catastrophic: false, confidence: 0.9 },
        '该公司成立于 2015 年，专注于人工智能领域的研发工作。',
      );
      assert.equal(output.score, 100);
      assert.match(output.summary ?? '', /未发现/);
      assert.equal(output.points?.length, 5);
      assert.ok(output.points?.every((point) => point.status === 'covered'));
      assert.ok(output.points?.every((point) => point.score === 100));
      const ratioPoint = output.points?.find((point) => point.label === '幻觉严重程度与占比');
      assert.equal(ratioPoint?.status, 'covered');
      assert.match(evidenceMd(ratioPoint), /无幻觉/);
    });

    it('第 5 维「幻觉严重程度与占比」独立成点：占比档位映射为维度分', () => {
      const item: HallucinationFinding = { type: 'entity', severity: 'severe', quote: '虚构机构', reason: '无法核实' };
      // 3 / 13 ≈ 23% → 10~30% 档 → 维度分 100 - 15 = 85
      const output = buildHallucinationOutput(
        { hallucinations: [item], catastrophic: false, confidence: 0.7 },
        `${item.quote}${'佐'.repeat(10)}`,
      );
      assert.equal(output.points?.length, 5);
      const ratioPoint = output.points?.find((point) => point.label === '幻觉严重程度与占比');
      assert.equal(ratioPoint?.status, 'missing');
      assert.equal(ratioPoint?.score, 85);
      const md = evidenceMd(ratioPoint);
      assert.match(md, /幻觉占比/);
      assert.match(md, /中度/); // 23% → 中度档
      assert.match(md, /重度 1 处/);
      assert.match(md, /占比加权扣分：15 分/);
    });

    it('四类幻觉扣分表（light/severe 共 8 档，占比固定 <10% 档）', () => {
      const cases: Array<{ label: string; item: HallucinationFinding; score: number; pointScore: number }> = [
        { label: 'entity light', item: { type: 'entity', severity: 'light', quote: '虚构机构', reason: '无法核实' }, score: 90, pointScore: 95 },
        { label: 'entity severe', item: { type: 'entity', severity: 'severe', quote: '虚构机构', reason: '无法核实' }, score: 80, pointScore: 85 },
        { label: 'numerical light', item: { type: 'numerical', severity: 'light', quote: '八成', reason: '无统计依据' }, score: 85, pointScore: 90 },
        { label: 'numerical severe', item: { type: 'numerical', severity: 'severe', quote: '八成', reason: '无统计依据' }, score: 75, pointScore: 80 },
        { label: 'citation light', item: { type: 'citation', severity: 'light', quote: '某研究', reason: '出处存疑' }, score: 80, pointScore: 85 },
        { label: 'citation severe', item: { type: 'citation', severity: 'severe', quote: '某研究', reason: '出处存疑' }, score: 70, pointScore: 75 },
        { label: 'logic_factual light', item: { type: 'logic_factual', severity: 'light', quote: '自相矛盾', reason: '前后矛盾' }, score: 85, pointScore: 90 },
        { label: 'logic_factual severe', item: { type: 'logic_factual', severity: 'severe', quote: '自相矛盾', reason: '前后矛盾' }, score: 75, pointScore: 80 },
      ];
      for (const { label, item, score, pointScore } of cases) {
        const output = buildHallucinationOutput(
          { hallucinations: [item], catastrophic: false, confidence: 0.7 },
          `${item.quote}${PAD}`,
        );
        assert.equal(output.score, score, `${label} 总分`);
        const missingPoint = output.points?.find((point) => point.status === 'missing');
        assert.equal(missingPoint?.score, pointScore, `${label} 维度分`);
        assert.equal(missingPoint?.status, 'missing', `${label} 状态`);
        assert.match(evidenceMd(missingPoint), /原文「/, `${label} 证据含原文`);
      }
    });

    it('占比加权三档：<10% 扣 5 / 10~30% 扣 15 / >30% 扣 30', () => {
      const item: HallucinationFinding = { type: 'entity', severity: 'light', quote: '虚构', reason: '无法核实' };
      const base = { hallucinations: [item], catastrophic: false, confidence: 0.7 };
      // 3 / 103 ≈ 2.9% → <10% 档 → 扣 5 → 100 - 5 - 5 = 90
      assert.equal(buildHallucinationOutput(base, `${item.quote}${'佐'.repeat(100)}`).score, 90);
      // 3 / 13 ≈ 23% → 10~30% 档 → 扣 15 → 100 - 5 - 15 = 80
      assert.equal(buildHallucinationOutput(base, `${item.quote}${'佐'.repeat(10)}`).score, 80);
      // 3 / 5 = 60% → >30% 档 → 扣 30 → 100 - 5 - 30 = 65
      assert.equal(buildHallucinationOutput(base, `${item.quote}${'佐'.repeat(2)}`).score, 65);
      // 无幻觉时占比加权不得凭空生效
      assert.equal(buildHallucinationOutput({ ...base, hallucinations: [] }, '简短回答。').score, 100);
    });

    it('catastrophic=true → 直接 0 分且保留 typeof number', () => {
      const output = buildHallucinationOutput(
        {
          hallucinations: [
            { type: 'entity', severity: 'severe', quote: '某药企', reason: '该药企不存在' },
            { type: 'numerical', severity: 'severe', quote: '有效率高达 99%', reason: '临床试验数据纯属编造' },
          ],
          catastrophic: true,
          confidence: 0.85,
        },
        '该药物由某药企研发，临床试验显示其有效率高达 99%，上市一年内治愈了数十万名患者。',
      );
      assert.equal(typeof output.score, 'number');
      assert.equal(output.score, 0);
      assert.match(output.summary ?? '', /0 分/);
      assert.equal(output.points?.length, 5);
      assert.equal(output.points?.find((point) => point.label === '实体幻觉')?.status, 'missing');
      assert.equal(output.points?.find((point) => point.label === '幻觉严重程度与占比')?.status, 'missing');
    });

    it('叠加扣分超过 100 时封底为 0 分（不出现负数）', () => {
      const items: HallucinationFinding[] = [
        { type: 'citation', severity: 'severe', quote: '文献一', reason: '编造' },
        { type: 'citation', severity: 'severe', quote: '文献二', reason: '编造' },
        { type: 'citation', severity: 'severe', quote: '文献三', reason: '编造' },
      ];
      // 类型扣 75 + 占比 >30% 扣 30 = 105 → 封底 0
      const output = buildHallucinationOutput(
        { hallucinations: items, catastrophic: false, confidence: 0.9 },
        `${items.map((i) => i.quote).join('')}${'佐'.repeat(5)}`,
      );
      assert.equal(typeof output.score, 'number');
      assert.equal(output.score, 0);
    });

    it('空回答 → 100 分跳过检测（优先于 catastrophic）', () => {
      const output = buildHallucinationOutput(
        { hallucinations: [{ type: 'entity', severity: 'severe', quote: 'x', reason: 'y' }], catastrophic: true, confidence: 1 },
        '   ',
      );
      assert.equal(output.score, 100);
      assert.equal(output.summary, '空回答，跳过幻觉检测');
    });

    it('evidence.md 报告含占比统计', () => {
      const output = buildHallucinationOutput(
        { hallucinations: [{ type: 'entity', severity: 'light', quote: '虚构机构', reason: '无法核实' }], catastrophic: false, confidence: 0.6 },
        `虚构机构${PAD}`,
      );
      const md = (output.evidence as { md?: string } | undefined)?.md ?? '';
      assert.match(md, /幻觉占比/);
      assert.match(md, /quote 总字数/);
      assert.match(md, /总分/);
    });
  });

  describe('集成：需求验收用例（fake judge 注入）', () => {
    it('用例1 无幻觉 → 100 分', async () => {
      setJudgeLlmCallerForTest(async () => JSON.stringify({ hallucinations: [], catastrophic: false, confidence: 0.92 }));
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '该公司成立于 2015 年，专注于人工智能领域的研发工作。',
      }));
      assert.equal(output.score, 100);
      assert.match(output.summary ?? '', /未发现/);
      assert.ok(output.points?.every((point) => point.status === 'covered'));
    });

    it('用例2 编造论文（引用幻觉）→ 60 分', async () => {
      setJudgeLlmCallerForTest(async () => JSON.stringify({
        hallucinations: [{
          type: 'citation', severity: 'severe',
          quote: '2024 年的一项行业研究显示',
          reason: '无法核实该研究报告的真实出处与结论',
        }],
        catastrophic: false,
        confidence: 0.75,
      }));
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '2024 年的一项行业研究显示，多数企业正在增加对生成式人工智能的投入，报告还给出了具体的增长比例。',
      }));
      assert.equal(output.score, 60);
      const citationPoint = output.points?.find((point) => point.label === '引用与文献幻觉');
      assert.equal(citationPoint?.status, 'missing');
      assert.equal(citationPoint?.score, 75);
      assert.match(evidenceMd(citationPoint), /2024 年的一项行业研究显示/);
      assert.equal(output.points?.find((point) => point.label === '实体幻觉')?.status, 'covered');
    });

    it('用例3 虚假统计（数值幻觉）→ 65 分', async () => {
      setJudgeLlmCallerForTest(async () => JSON.stringify({
        hallucinations: [{
          type: 'numerical', severity: 'severe',
          quote: '约有八成',
          reason: '该比例无公开统计依据，属编造数据',
        }],
        catastrophic: false,
        confidence: 0.8,
      }));
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '调查显示，参与调研的企业中约有八成在采用新方案后提升了效率，其余企业变化不大。',
      }));
      assert.equal(output.score, 65);
      assert.equal(output.points?.find((point) => point.label === '数值幻觉')?.status, 'missing');
    });

    it('用例4 虚构实体 → 70 分', async () => {
      setJudgeLlmCallerForTest(async () => JSON.stringify({
        hallucinations: [{
          type: 'entity', severity: 'severe',
          quote: '星辰实验室',
          reason: '该机构不存在，为虚构实体',
        }],
        catastrophic: false,
        confidence: 0.82,
      }));
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '该产品由星辰实验室研发，其核心算法在国际评测中排名前列。',
      }));
      assert.equal(output.score, 70);
      assert.equal(output.points?.find((point) => point.label === '实体幻觉')?.status, 'missing');
    });

    it('用例5 逻辑矛盾 → 65 分', async () => {
      setJudgeLlmCallerForTest(async () => JSON.stringify({
        hallucinations: [{
          type: 'logic_factual', severity: 'severe',
          quote: '完全不联网的环境下工作',
          reason: '与后文「必须依赖云端实时数据才能运行」自相矛盾',
        }],
        catastrophic: false,
        confidence: 0.78,
      }));
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '该方案既能在完全不联网的环境下工作，又必须依赖云端实时数据才能运行，两者同时成立。',
      }));
      assert.equal(output.score, 65);
      assert.equal(output.points?.find((point) => point.label === '逻辑与事实幻觉')?.status, 'missing');
    });

    it('用例6 混合幻觉 → 35 分（多类各自扣分 + 占比加权）', async () => {
      setJudgeLlmCallerForTest(async () => JSON.stringify({
        hallucinations: [
          { type: 'citation', severity: 'severe', quote: '据虚拟研究院 2022 年报告', reason: '该研究院及报告均不存在' },
          { type: 'numerical', severity: 'light', quote: '约三成', reason: '该比例来源不明，无法核实' },
        ],
        catastrophic: false,
        confidence: 0.7,
      }));
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '据虚拟研究院 2022 年报告，约三成团队采用了新框架，其余团队仍沿用旧方案。',
      }));
      assert.equal(output.score, 35);
      assert.equal(output.points?.find((point) => point.label === '引用与文献幻觉')?.status, 'missing');
      assert.equal(output.points?.find((point) => point.label === '数值幻觉')?.status, 'missing');
      assert.equal(output.points?.find((point) => point.label === '实体幻觉')?.status, 'covered');
    });

    it('用例7 轻度脑补（light 档）→ 75 分', async () => {
      setJudgeLlmCallerForTest(async () => JSON.stringify({
        hallucinations: [{
          type: 'logic_factual', severity: 'light',
          quote: '泛化能力相当出色',
          reason: '由单一基准测试推断整体泛化能力，属轻度脑补',
        }],
        catastrophic: false,
        confidence: 0.8,
      }));
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '该算法在标准测试集上的表现略优于同类方法，说明其泛化能力相当出色。',
      }));
      assert.equal(output.score, 75);
      assert.match(output.summary ?? '', /轻度/);
      const logicPoint = output.points?.find((point) => point.label === '逻辑与事实幻觉');
      assert.equal(logicPoint?.status, 'missing');
      assert.equal(logicPoint?.score, 90);
    });

    it('用例8 空回答 → 100 分且不调用 judge', async () => {
      let called = false;
      setJudgeLlmCallerForTest(async () => {
        called = true;
        return JSON.stringify({ hallucinations: [], catastrophic: false, confidence: 1 });
      });
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '   ',
      }));
      assert.equal(called, false);
      assert.equal(output.score, 100);
      assert.equal(output.summary, '空回答，跳过幻觉检测');
    });

    it('用例9 严重幻觉（catastrophic）→ 0 分', async () => {
      setJudgeLlmCallerForTest(async () => JSON.stringify({
        hallucinations: [
          { type: 'entity', severity: 'severe', quote: '北方制药', reason: '该药企不存在' },
          { type: 'numerical', severity: 'severe', quote: '有效率高达 99%', reason: '临床试验数据纯属编造' },
        ],
        catastrophic: true,
        confidence: 0.8,
      }));
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '该药物由北方制药研发，临床试验显示其有效率高达 99%，上市一年内治愈了数十万名患者。',
      }));
      assert.equal(typeof output.score, 'number');
      assert.equal(output.score, 0);
      assert.match(output.summary ?? '', /虚构/);
    });

    it('用例10 有检索上下文：interactions 注入后 prompt 含证据，按上下文判定', async () => {
      let captured = { system: '', user: '' };
      setJudgeLlmCallerForTest(async (_user, req) => {
        captured = { system: req.system, user: req.user };
        return JSON.stringify({ hallucinations: [], catastrophic: false, confidence: 0.9 });
      });
      const output = await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        caseInput: '该产品定价多少？',
        actualOutput: '根据检索到的资料，该产品的定价为 100 元。',
        interactions: [
          { role: 'user', content: '查询产品定价' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'search', arguments: '{}' },
              state: 'success',
              output: '产品价格文档：该产品定价 100 元，于 2024 年发布。',
            }],
          },
        ],
      }));
      // 提取到的检索证据拼入 user prompt，并走「结合检索上下文判定」系统提示
      assert.match(captured.user, /产品价格文档/);
      assert.match(captured.user, /ctx-1/);
      assert.match(captured.system, /标记为幻觉/);
      assert.equal(output.score, 100);
    });

    it('无上下文走知识判断路径：系统提示含 unknown 机制与禁止凭空断言', async () => {
      let system = '';
      setJudgeLlmCallerForTest(async (_user, req) => {
        system = req.system;
        return JSON.stringify({ hallucinations: [], catastrophic: false, confidence: 0.8 });
      });
      await runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
        actualOutput: '这是一个完全真实的回答。',
        interactions: [],
      }));
      assert.match(system, /unknown/);
      assert.match(system, /禁止凭空断言/);
      assert.doesNotMatch(system, /结合检索上下文判定/);
    });
  });

  describe('语义层：非法 Judge 输出抛 JudgeOutputParseError（禁止兜底）', () => {
    const badOutputs: Array<[string, string]> = [
      ['条目缺少 type', JSON.stringify({ hallucinations: [{ severity: 'severe', quote: '内容', reason: '原因' }] })],
      ['未知 type 枚举', JSON.stringify({ hallucinations: [{ type: 'made_up', severity: 'severe', quote: '内容', reason: '原因' }] })],
      ['未知 severity 枚举', JSON.stringify({ hallucinations: [{ type: 'entity', severity: 'moderate', quote: '内容', reason: '原因' }] })],
      ['空 quote', JSON.stringify({ hallucinations: [{ type: 'entity', severity: 'light', quote: '', reason: '原因' }] })],
      ['空白 quote', JSON.stringify({ hallucinations: [{ type: 'entity', severity: 'light', quote: '   ', reason: '原因' }] })],
      ['空 reason', JSON.stringify({ hallucinations: [{ type: 'entity', severity: 'light', quote: '内容', reason: '' }] })],
      ['字符串条目（类型层宽容但语义层缺字段）', JSON.stringify({ hallucinations: ['只有引用片段'] })],
    ];
    for (const [label, raw] of badOutputs) {
      it(`${label} → JudgeOutputParseError`, async () => {
        setJudgeLlmCallerForTest(async () => raw);
        await assert.rejects(
          () => runHallucinationPreset('preset-hallucination-text', 'u', makeContext({
            actualOutput: '这是一段待评估的回答内容。',
          })),
          JudgeOutputParseError,
        );
      });
    }
  });
});
