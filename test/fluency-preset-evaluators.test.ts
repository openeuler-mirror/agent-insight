/** 流畅度预置评估器的 Judge 契约与确定性计分测试。 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import {
  FLUENCY_PRESET_IDS,
  buildFluencyOutput,
  fluencyTier,
  isFluencyPresetId,
  runFluencyPreset,
  type FluencyDimension,
  type FluencyIssue,
  type FluencySeverity,
} from '@/lib/engine/experiment/fluency-preset-evaluators';

function issue(
  dimension: FluencyDimension,
  severity: FluencySeverity,
  quote: string,
  reason: string,
  suggestion = '',
): FluencyIssue {
  // severe 必须带 suggestion（schema 交叉校验），测试 helper 自动补齐
  return {
    dimension,
    severity,
    quote,
    reason,
    suggestion: suggestion || (severity === 'severe' ? '补充修改建议' : ''),
    count: 1,
  };
}

function fluencyContext(actualOutput: string) {
  return {
    caseInput: '请评估以下文本的流畅度',
    actualOutput,
    referenceOutput: null,
    traceSummaryText: null,
    interactions: [],
    taskId: null,
    executionId: null,
  };
}

afterEach(() => setJudgeLlmCallerForTest(null));

describe('流畅度预置评估器', () => {
  it('preset id 常量与识别函数', () => {
    assert.deepEqual(FLUENCY_PRESET_IDS, ['preset-fluency-text']);
    assert.equal(isFluencyPresetId('preset-fluency-text'), true);
    assert.equal(isFluencyPresetId('preset-hallucination-text'), false);
    assert.equal(isFluencyPresetId('preset-result-faithfulness'), false);
  });

  it('高度流畅文本：无问题清单 → 100 分（用例 1）', async () => {
    let systemPrompt = '';
    let userPrompt = '';
    setJudgeLlmCallerForTest(async (_user, request) => {
      systemPrompt = request.system;
      userPrompt = request.user;
      return JSON.stringify({ issues: [], confidence: 0.95 });
    });
    const text = '清晨的阳光洒进房间，窗台上的绿植舒展着叶片，整个屋子显得安静而明亮。';
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext(text));

    assert.equal(output.score, 100);
    assert.equal(output.summary, '未发现明显流畅度问题，文本整体通顺。');
    assert.equal(output.points?.length, 5);
    assert.equal(output.points?.every((point) => point.status === 'covered' && point.score === 100), true);
    assert.match(systemPrompt, /语句通顺度/);
    assert.match(systemPrompt, /重复与冗余/);
    assert.match(systemPrompt, /断句与节奏/);
    assert.match(systemPrompt, /语义连贯性/);
    assert.match(systemPrompt, /语言自然度/);
    assert.match(userPrompt, /清晨的阳光/);
  });

  it('病句文本：语句通顺度重扣 → 70~80 分（用例 2）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [
        issue('sentence_smoothness', 'severe', '因为交通拥堵的原因导致会议延迟开始。', '句式杂糅且缺少主语，读不通顺。'),
        issue('sentence_smoothness', 'light', '我们对此表达了看法。', '搭配略显生硬，可更自然。'),
      ],
    }));
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('病句示例文本。'));

    assert.ok(output.score! >= 70 && output.score! <= 80, `期望 70~80，实际 ${output.score}`);
    assert.equal(output.score, 75);
    const smoothPoint = output.points?.find((point) => point.label === '语句通顺度');
    assert.equal(smoothPoint?.status, 'missing');
    assert.equal(smoothPoint?.score, 75);
    assert.match((smoothPoint?.evidence as { md?: string } | undefined)?.md ?? '', /句式杂糅/);
  });

  it('重复文本：重复与冗余扣分 → 60~70 分（用例 3）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [
        issue('repetition_and_redundancy', 'severe', '这个提议非常关键，非常必要，非常重要。', '同一观点反复强调，语义重复。'),
        issue('repetition_and_redundancy', 'severe', '我们应该认真对待这个问题。', '与前文表述内容重复。'),
        issue('repetition_and_redundancy', 'light', '可以说，总体上来讲', '口语赘词堆砌。'),
        issue('repetition_and_redundancy', 'severe', '再次强调，必须给予高度关注。', '再次重复强调同一意思。'),
      ],
    }));
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('重复示例文本。'));

    assert.ok(output.score! >= 60 && output.score! <= 70, `期望 60~70，实际 ${output.score}`);
    assert.equal(output.score, 65);
    const repetitionPoint = output.points?.find((point) => point.label === '重复与冗余');
    assert.equal(repetitionPoint?.status, 'missing');
    assert.equal(repetitionPoint?.score, 65);
  });

  it('长句不断句：断句与节奏扣分 → 60~70 分（用例 4）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [
        issue('sentence_break_and_rhythm', 'severe', '这项政策涉及到多个部门多个环节多个利益群体。', '缺少停顿，一口气读不完的长句。'),
        issue('sentence_break_and_rhythm', 'moderate', '我们需要尽快完成调研形成报告提交审核。', '多个动作连排无断句。'),
        issue('sentence_break_and_rhythm', 'light', '随后接着往下推进。', '连接词略显拖沓。'),
        issue('sentence_break_and_rhythm', 'moderate', '数据的采集清洗标注都集中在同一个阶段。', '并列成分过多缺少停顿。'),
        issue('sentence_break_and_rhythm', 'moderate', '以上步骤需按顺序逐步完成不得跳跃。', '句末缺标点助读。'),
      ],
    }));
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('长句示例文本。'));

    assert.ok(output.score! >= 60 && output.score! <= 70, `期望 60~70，实际 ${output.score}`);
    assert.equal(output.score, 64);
    const rhythmPoint = output.points?.find((point) => point.label === '断句与节奏');
    assert.equal(rhythmPoint?.status, 'missing');
  });

  it('语义跳跃文本：语义连贯性扣分 → 50~60 分（用例 5）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [
        issue('semantic_coherence', 'severe', '昨天我们讨论了预算问题。', '后文突然转向人事安排，话题无过渡。'),
        issue('semantic_coherence', 'severe', '另外天气也很好。', '与前文逻辑完全断裂。'),
        issue('semantic_coherence', 'light', '总之情况就是这样。', '结论与前述内容缺乏承接。'),
        issue('semantic_coherence', 'severe', '所以最终决定了新的采购方案。', '因果链断裂，结论来源不明。'),
      ],
    }));
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('语义跳跃示例文本。'));

    assert.ok(output.score! >= 50 && output.score! <= 60, `期望 50~60，实际 ${output.score}`);
    assert.equal(output.score, 50);
    const coherencePoint = output.points?.find((point) => point.label === '语义连贯性');
    assert.equal(coherencePoint?.status, 'missing');
    assert.equal(coherencePoint?.score, 50);
  });

  it('翻译腔文本：语言自然度扣分 → 70~80 分（用例 6）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [
        issue('language_naturalness', 'severe', '在被考虑的那些选项中，我们选择了这一方案。', '欧化句式，被动与定语前置不符合中文习惯。'),
        issue('language_naturalness', 'moderate', '这是一个关于我们如何能够更好地合作的问题。', '翻译腔明显，冗长的从句结构。'),
        issue('language_naturalness', 'light', '在某种程度上来说', '生硬的书面套话。'),
      ],
    }));
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('翻译腔示例文本。'));

    assert.ok(output.score! >= 70 && output.score! <= 80, `期望 70~80，实际 ${output.score}`);
    assert.equal(output.score, 78);
    const naturalnessPoint = output.points?.find((point) => point.label === '语言自然度');
    assert.equal(naturalnessPoint?.status, 'missing');
    assert.equal(naturalnessPoint?.score, 78);
  });

  it('族内 judge 通道固定传 temperature 0 + maxTokens 8192（S1/S4，不影响其他评估器）', async () => {
    let captured: { modelOptions?: Record<string, unknown> } = {};
    setJudgeLlmCallerForTest(async (_user, request) => {
      captured = request;
      return JSON.stringify({ issues: [] });
    });
    await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('示例文本。'));
    assert.deepEqual(captured.modelOptions, { temperature: 0, maxTokens: 8192 });
  });

  it('空文本：跳过评估，不调用 judge，100 分（用例 7）', async () => {
    let called = false;
    setJudgeLlmCallerForTest(async () => {
      called = true;
      return JSON.stringify({ issues: [] });
    });
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('   \n\t '));

    assert.equal(called, false);
    assert.equal(output.score, 100);
    assert.equal(output.summary, '空文本，跳过流畅度评估');
    assert.equal(output.points, undefined);
  });

  it('混合问题文本：多维叠加扣分 → 50~60 分（用例 8）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [
        issue('sentence_smoothness', 'severe', '由于资源限制导致项目未能按期交付。', '成分残缺，主语缺失。'),
        issue('repetition_and_redundancy', 'light', '比较而言相对而言', '同义赘词重复。'),
        issue('sentence_break_and_rhythm', 'severe', '风险识别评估应对监控需要形成闭环。', '长句不断句。'),
        issue('semantic_coherence', 'moderate', '最后我们决定先上线。', '与上文风险讨论衔接不足。'),
        issue('sentence_smoothness', 'light', '这显然是一个合理的选择。', '表达略显口语化。'),
      ],
    }));
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('混合示例文本。'));

    assert.ok(output.score! >= 50 && output.score! <= 60, `期望 50~60，实际 ${output.score}`);
    assert.equal(output.score, 50);
    assert.equal(output.points?.filter((point) => point.status === 'missing').length, 4);
    assert.equal(output.points?.find((point) => point.label === '语言自然度')?.status, 'covered');
  });

  it('极短文本：无问题 → 100 分（用例 9）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({ issues: [] }));
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('好的。'));

    assert.equal(output.score, 100);
    assert.equal(output.points?.every((point) => point.status === 'covered'), true);
  });

  it('专业文档：无问题清单 → 100 分（用例 10）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({ issues: [], confidence: 0.9 }));
    const text = '本报告基于对三家样本企业的实地调研，从组织架构、流程效率与人才结构三个维度分析了数字化转型的现状，并据此提出了分阶段的实施建议。';
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext(text));

    assert.equal(output.score, 100);
    assert.equal(output.points?.length, 5);
    assert.equal(output.points?.every((point) => point.status === 'covered' && point.score === 100), true);
    assert.equal(output.summary, '未发现明显流畅度问题，文本整体通顺。');
  });
});

describe('buildFluencyOutput 确定性计分纯函数', () => {
  it('空文本/空白 → 100 分并跳过', () => {
    for (const text of ['', '   ', '\n\t']) {
      const output = buildFluencyOutput({ issues: [] }, text);
      assert.equal(output.score, 100);
      assert.equal(output.summary, '空文本，跳过流畅度评估');
    }
  });

  it('无问题 → 100 分，五个维度均 covered', () => {
    const output = buildFluencyOutput({ issues: [] }, '这是一段完全通顺的中文文本。');
    assert.equal(typeof output.score, 'number');
    assert.equal(output.score, 100);
    assert.equal(output.points?.length, 5);
    assert.equal(output.points?.every((point) => point.status === 'covered' && point.score === 100), true);
    assert.match((output.evidence as { md?: string }).md ?? '', /总分：100/);
  });

  it('单维度扣分：按档位表聚合', () => {
    const output = buildFluencyOutput({
      issues: [
        issue('sentence_smoothness', 'severe', '病句A', '成分残缺'),
        issue('sentence_smoothness', 'moderate', '病句B', '搭配不当'),
        issue('sentence_smoothness', 'light', '病句C', '轻微瑕疵'),
      ],
    }, '示例文本。');
    // 连续 3 非 light？[severe, moderate] 连续段长 2，light 打断 → 不翻倍
    assert.equal(output.score, 65); // 100 - (20 + 10 + 5)
    const smoothPoint = output.points?.find((point) => point.label === '语句通顺度');
    assert.equal(smoothPoint?.score, 65);
    assert.equal(smoothPoint?.status, 'missing');
    assert.equal(output.points?.find((point) => point.label === '语言自然度')?.status, 'covered');
  });

  it('连续 3 处中度问题 → 前 3 处不翻倍（需求口径：第 4 处起才加倍）', () => {
    const output = buildFluencyOutput({
      issues: [
        issue('sentence_smoothness', 'moderate', 'a', 'r'),
        issue('sentence_smoothness', 'moderate', 'b', 'r'),
        issue('sentence_smoothness', 'moderate', 'c', 'r'),
      ],
    }, '示例文本。');
    assert.equal(output.score, 70); // 10+10+10 = 30 → 70，段内无第 4 处 → 不翻倍
    assert.doesNotMatch((output.evidence as { md?: string }).md ?? '', /扣分加倍/);
  });

  it('连续 4 处中度问题 → 第 4 处扣分加倍', () => {
    const output = buildFluencyOutput({
      issues: [
        issue('sentence_smoothness', 'moderate', 'a', 'r'),
        issue('sentence_smoothness', 'moderate', 'b', 'r'),
        issue('sentence_smoothness', 'moderate', 'c', 'r'),
        issue('sentence_smoothness', 'moderate', 'd', 'r'),
      ],
    }, '示例文本。');
    assert.equal(output.score, 50); // 10×3 + 10×2 = 50 → 50
    assert.match((output.evidence as { md?: string }).md ?? '', /扣分加倍/);
  });

  it('连续 2 处中度问题 → 不翻倍', () => {
    const output = buildFluencyOutput({
      issues: [
        issue('sentence_smoothness', 'moderate', 'a', 'r'),
        issue('sentence_smoothness', 'moderate', 'b', 'r'),
      ],
    }, '示例文本。');
    assert.equal(output.score, 80); // 10+10 = 20 → 80
  });

  it('滑动窗口：light 打断连续段，加倍按段内相对位置计算', () => {
    // [m,m,m,light]：连续段长 3，无第 4 处 → 不翻倍 → 10×3 + 5 = 35 → 65
    const notDoubled = buildFluencyOutput({
      issues: [
        issue('sentence_smoothness', 'moderate', 'a', 'r'),
        issue('sentence_smoothness', 'moderate', 'b', 'r'),
        issue('sentence_smoothness', 'moderate', 'c', 'r'),
        issue('sentence_smoothness', 'light', 'd', 'r'),
      ],
    }, '示例文本。');
    assert.equal(notDoubled.score, 65);

    // [m,light,m,m,m,m]：后段长 4，段内第 4 处加倍 → 10+5+10+10+10+20 = 65 → 35
    const afterLight = buildFluencyOutput({
      issues: [
        issue('sentence_smoothness', 'moderate', 'a', 'r'),
        issue('sentence_smoothness', 'light', 'b', 'r'),
        issue('sentence_smoothness', 'moderate', 'c', 'r'),
        issue('sentence_smoothness', 'moderate', 'd', 'r'),
        issue('sentence_smoothness', 'moderate', 'e', 'r'),
        issue('sentence_smoothness', 'moderate', 'f', 'r'),
      ],
    }, '示例文本。');
    assert.equal(afterLight.score, 35);
  });

  it('count 字段：单条重复 issue 按出现次数计分并参与连续加倍（用例 3 口径）', () => {
    const output = buildFluencyOutput({
      issues: [{
        dimension: 'repetition_and_redundancy',
        severity: 'moderate',
        quote: '非常好，非常优秀，非常出色，非常值得推荐',
        reason: '同一修饰词「非常」重复 4 次',
        suggestion: '合并为简洁表达',
        count: 4,
      }],
    }, '示例文本。');
    assert.equal(output.score, 65); // 展开 4 位：7×3 + 7×2(第4处加倍) = 35 → 65
    assert.match((output.evidence as { md?: string }).md ?? '', /重复 4 次/);
    assert.match((output.evidence as { md?: string }).md ?? '', /扣分加倍/);
  });

  it('count 缺省为 1：与逐条上报计分一致', () => {
    const viaCount = buildFluencyOutput({
      issues: [{ dimension: 'repetition_and_redundancy', severity: 'moderate', quote: 'x', reason: 'r', suggestion: '', count: 2 }],
    }, '示例文本。');
    const viaSplit = buildFluencyOutput({
      issues: [
        issue('repetition_and_redundancy', 'moderate', 'x', 'r'),
        issue('repetition_and_redundancy', 'moderate', 'x', 'r'),
      ],
    }, '示例文本。');
    assert.equal(viaCount.score, viaSplit.score); // 7+7=14，无加倍
  });

  it('count 非法值（0）→ JudgeOutputParseError', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [{ dimension: 'repetition_and_redundancy', severity: 'moderate', quote: 'x', reason: 'y', count: 0 }],
    }));
    await assert.rejects(
      () => runFluencyPreset('preset-fluency-text', 'u', fluencyContext('文本。')),
      JudgeOutputParseError,
    );
  });

  it('重复 count≥3 且 judge 报 light → 代码抬升为 moderate 计分（F3 兜底）', () => {
    const output = buildFluencyOutput({
      issues: [{
        dimension: 'repetition_and_redundancy',
        severity: 'light',
        quote: '非常好，非常优秀，非常出色，非常值得推荐',
        reason: '同一修饰词重复 4 次',
        suggestion: '精简表达',
        count: 4,
      }],
    }, '示例文本。');
    assert.equal(output.score, 65); // 抬升 moderate：7×3 + 7×2(第4处加倍) = 35 → 65（原 light 口径为 75）
    const repetitionPoint = output.points?.find((point) => point.label === '重复与冗余');
    assert.equal(repetitionPoint?.score, 65);
  });

  it('重复 count<3 → 不抬升，按原档计分', () => {
    const output = buildFluencyOutput({
      issues: [{
        dimension: 'repetition_and_redundancy',
        severity: 'light',
        quote: '非常重要，非常必要',
        reason: '同一修饰词重复 2 次',
        suggestion: '',
        count: 2,
      }],
    }, '示例文本。');
    assert.equal(output.score, 90); // 5×2 = 10 → 90
  });

  it('severe 问题缺 suggestion → JudgeOutputParseError（有分必有据）', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [{ dimension: 'sentence_smoothness', severity: 'severe', quote: 'x', reason: 'y' }],
    }));
    await assert.rejects(
      () => runFluencyPreset('preset-fluency-text', 'u', fluencyContext('文本。')),
      JudgeOutputParseError,
    );
  });

  it('叠加扣分归零：扣分远超 100 → 0 分', () => {
    const output = buildFluencyOutput({
      issues: Array.from({ length: 6 }, () =>
        issue('sentence_smoothness', 'severe', '严重病句', '成分严重残缺')),
    }, '示例文本。');
    assert.equal(output.score, 0); // 3×20 + 3×40 = 180 → 0
  });

  it('0 分保留 number 类型（不做假值判断）', () => {
    const output = buildFluencyOutput({
      issues: Array.from({ length: 5 }, () =>
        issue('semantic_coherence', 'severe', '语义断裂', '逻辑完全断裂')),
    }, '示例文本。');
    assert.equal(typeof output.score, 'number');
    assert.equal(output.score, 0); // 3×15 + 2×30 = 105 → 0
    const coherencePoint = output.points?.find((point) => point.label === '语义连贯性');
    assert.equal(coherencePoint?.score, 0);
  });
});

describe('judge 输出自动修复（S2：坏 JSON 第二次尝试，仍走严格契约）', () => {
  it('字符串内未转义引号 → 修复后正常计分', async () => {
    setJudgeLlmCallerForTest(async () =>
      '{"issues":[{"dimension":"sentence_smoothness","severity":"moderate",'
      + '"quote":"他说「这个方案」可行","reason":"他说"这个方案"可行但缺主语","suggestion":"补主语"}],"confidence":0.8}');
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('病句文本。'));
    assert.equal(output.score, 90); // moderate 扣 10
    const smoothPoint = output.points?.find((point) => point.label === '语句通顺度');
    assert.equal(smoothPoint?.status, 'missing');
  });

  it('截断：末尾缺闭合括号 → 补全后按已有条目计分', async () => {
    setJudgeLlmCallerForTest(async () =>
      '{"issues":[{"dimension":"sentence_smoothness","severity":"severe","quote":"病句","reason":"成分残缺","suggestion":"补主语"}]');
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('病句文本。'));
    assert.equal(output.score, 80); // severe 扣 20
  });

  it('截断：数组中间切断 → 保留已完整的条目', async () => {
    setJudgeLlmCallerForTest(async () =>
      '{"issues":[{"dimension":"sentence_smoothness","severity":"moderate","quote":"a","reason":"r"},'
      + '{"dimension":"repetition_and_redundancy","severity":"light","quote":"b","reason":"未');
    const output = await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('示例文本。'));
    assert.equal(output.score, 90); // 只保留第一条 moderate
  });

  it('修复产物仍受 schema 约束：issues 非数组 → JudgeOutputParseError', async () => {
    setJudgeLlmCallerForTest(async () => '{"issues": 完全不是数组内容');
    await assert.rejects(
      () => runFluencyPreset('preset-fluency-text', 'u', fluencyContext('文本。')),
      JudgeOutputParseError,
    );
  });
});

describe('流畅度语义层严格校验（不兜底默认档）', () => {
  it('缺 dimension → JudgeOutputParseError', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [{ severity: 'moderate', quote: 'x', reason: 'y' }],
    }));
    await assert.rejects(
      () => runFluencyPreset('preset-fluency-text', 'u', fluencyContext('文本。')),
      JudgeOutputParseError,
    );
  });

  it('未知 severity → JudgeOutputParseError', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [{ dimension: 'sentence_smoothness', severity: 'critical', quote: 'x', reason: 'y' }],
    }));
    await assert.rejects(
      () => runFluencyPreset('preset-fluency-text', 'u', fluencyContext('文本。')),
      JudgeOutputParseError,
    );
  });

  it('空 quote → JudgeOutputParseError', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [{ dimension: 'sentence_smoothness', severity: 'moderate', quote: '', reason: 'y' }],
    }));
    await assert.rejects(
      () => runFluencyPreset('preset-fluency-text', 'u', fluencyContext('文本。')),
      JudgeOutputParseError,
    );
  });

  it('缺 quote → JudgeOutputParseError', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [{ dimension: 'sentence_smoothness', severity: 'moderate', reason: 'y' }],
    }));
    await assert.rejects(
      () => runFluencyPreset('preset-fluency-text', 'u', fluencyContext('文本。')),
      JudgeOutputParseError,
    );
  });

  it('缺 reason → JudgeOutputParseError', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      issues: [{ dimension: 'sentence_smoothness', severity: 'moderate', quote: 'x' }],
    }));
    await assert.rejects(
      () => runFluencyPreset('preset-fluency-text', 'u', fluencyContext('文本。')),
      JudgeOutputParseError,
    );
  });

  it('非法 judge 输出（非 JSON）→ JudgeOutputParseError', async () => {
    setJudgeLlmCallerForTest(async () => '这不是 JSON');
    await assert.rejects(
      () => runFluencyPreset('preset-fluency-text', 'u', fluencyContext('文本。')),
      JudgeOutputParseError,
    );
  });
});

describe('流畅度 prompt 泛化判据', () => {
  it('四档划分边界（需求评分规则）', () => {
    assert.equal(fluencyTier(100), '总体流畅');
    assert.equal(fluencyTier(90), '总体流畅');
    assert.equal(fluencyTier(89.9), '基本流畅');
    assert.equal(fluencyTier(70), '基本流畅');
    assert.equal(fluencyTier(69.9), '不流畅');
    assert.equal(fluencyTier(40), '不流畅');
    assert.equal(fluencyTier(39.9), '严重不流畅');
    assert.equal(fluencyTier(0), '严重不流畅');
  });

  it('报告含档位标签', () => {
    const output = buildFluencyOutput(
      { issues: [issue('semantic_coherence', 'severe', '句A。句B。', '话题跳跃', '加过渡')] },
      '句A。句B。',
    );
    const md = (output.evidence as { md?: string } | undefined)?.md ?? '';
    assert.match(md, /基本流畅/);
  });

  it('system 用泛化判据定义五维，不写死验收用例原句', async () => {
    let systemPrompt = '';
    let userPrompt = '';
    setJudgeLlmCallerForTest(async (_user, request) => {
      systemPrompt = request.system;
      userPrompt = request.user;
      return JSON.stringify({ issues: [] });
    });
    const text = '需要评估的文本内容。';
    await runFluencyPreset('preset-fluency-text', 'u', fluencyContext(text));

    assert.doesNotMatch(systemPrompt, /通过这次学习，使我的水平有了很大提高/);
    assert.doesNotMatch(systemPrompt, /这个方案非常好/);
    assert.doesNotMatch(systemPrompt, /今天天气很好/);
    assert.doesNotMatch(systemPrompt, /我吃饭在食堂/);
    assert.match(systemPrompt, /第 4 处起会被加倍扣分/);
    assert.match(systemPrompt, /必须引用原文片段/);
    assert.match(systemPrompt, /无法确定时不报告/);
    // A4：五维判据覆盖需求识别项（泛化描述）
    assert.match(systemPrompt, /成分残缺/);
    assert.match(systemPrompt, /量词\/介词\/连词使用错误/);
    assert.match(systemPrompt, /超过 80 字的长句/);
    assert.match(systemPrompt, /标点符号使用错误/);
    assert.match(systemPrompt, /指代不清/);
    assert.match(systemPrompt, /翻译腔明显/);
    assert.match(systemPrompt, /「其」「该」「之」/);
    assert.match(userPrompt, /8000/);
    assert.match(userPrompt, new RegExp(text));
  });

  it('user prompt 注明文本长度上限与截断', async () => {
    let userPrompt = '';
    setJudgeLlmCallerForTest(async (_user, request) => {
      userPrompt = request.user;
      return JSON.stringify({ issues: [] });
    });
    await runFluencyPreset('preset-fluency-text', 'u', fluencyContext('示例。'));
    assert.match(userPrompt, /文本长度上限 8000 字/);
    assert.match(userPrompt, /超出部分已截断/);
  });
});
