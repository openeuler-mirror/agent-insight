/**
 * 任务完成度（无标准答案）评估器测试。
 *
 * 注入点在 setJudgeLlmCallerForTest（judge 边界），完整走全链路。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setJudgeLlmCallerForTest } from '../src/lib/engine/experiment/judge-llm';
import {
  runTaskCompletionNoRef,
} from '../src/lib/engine/experiment/task-completion-preset-evaluators';

const USER = 'test';

function ctx(input: string, output: string) {
  return {
    caseInput: input,
    actualOutput: output,
    referenceOutput: null,
    traceSummaryText: null,
    interactions: [],
    taskId: null,
    executionId: null,
    user: null,
    execution: null,
  };
}

function inject(json: string) {
  setJudgeLlmCallerForTest(async () => json);
}

function buildJudgeResult(overrides: {
  overall_reason?: string;
  explicit_completion_score?: number;
  implicit_constraint_score?: number;
  information_sufficiency_score?: number;
  requirement_results?: Array<{
    content: string;
    type: 'explicit' | 'implicit' | 'business_must_have';
    confidence: 'high' | 'medium' | 'low';
    verdict: 'covered' | 'partially_covered' | 'not_covered' | 'not_applicable';
    reason: string;
  }>;
  overall_analysis?: string;
}) {
  return JSON.stringify({
    overall_reason: overrides.overall_reason ?? '任务完成度评估结果。',
    inferred_requirements: overrides.requirement_results ?? [],
    requirement_results: overrides.requirement_results ?? [],
    explicit_completion_score: overrides.explicit_completion_score ?? 100,
    implicit_constraint_score: overrides.implicit_constraint_score ?? 100,
    information_sufficiency_score: overrides.information_sufficiency_score ?? 100,
    overall_analysis: overrides.overall_analysis ?? '综合分析。',
  });
}

// ── 用例 ──────────────────────────────────────────────────────────────────────

describe('任务完成度（无标准答案）评估器 全链路', () => {
  it('用例1: 显式需求和隐含约束均满足 → ≥90', async () => {
    inject(buildJudgeResult({
      overall_reason: '邮件通知完整，时间、语气、格式均符合要求。',
      explicit_completion_score: 100,
      implicit_constraint_score: 95,
      information_sufficiency_score: 95,
      requirement_results: [
        { content: '通知会议改期', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '明确说明了时间变更' },
        { content: '写明新时间（周三下午两点）', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '时间明确' },
        { content: '简短', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '长度适中' },
        { content: '收件人称呼', type: 'implicit', confidence: 'high', verdict: 'covered', reason: '有称呼语' },
        { content: '发件人署名', type: 'implicit', confidence: 'medium', verdict: 'covered', reason: '有署名' },
        { content: '职业语气', type: 'implicit', confidence: 'high', verdict: 'covered', reason: '语气得体' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '帮我写一封简短的邮件，通知团队下周一的会议改到周三下午两点。',
      '邮件正文...',
    ));
    assert.ok(r.score! >= 90, `expected >=90, got ${r.score}`);
    assert.equal(r.verdict, 'pass');
  });

  it('用例2: 显式需求遗漏 → ≤50', async () => {
    inject(buildJudgeResult({
      overall_reason: '未完成对比推荐，显式需求遗漏。',
      explicit_completion_score: 30,
      implicit_constraint_score: 60,
      information_sufficiency_score: 60,
      requirement_results: [
        { content: '查询北京天气', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '已提供' },
        { content: '查询上海天气', type: 'explicit', confidence: 'high', verdict: 'partially_covered', reason: '仅提供了气温' },
        { content: '对比推荐更适合户外活动的城市', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '未做对比推荐' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '请查一下明天北京和上海的天气，并告诉我哪个更适合户外活动。',
      '北京晴天，上海气温25度。',
    ));
    assert.ok(r.score! <= 50, `expected <=50, got ${r.score}`);
  });

  it('用例3: 开放式任务但明显不合理 → ≤40', async () => {
    inject(buildJudgeResult({
      overall_reason: '推荐内容质量低下，推荐理由浮夸。',
      explicit_completion_score: 50,
      implicit_constraint_score: 20,
      information_sufficiency_score: 20,
      requirement_results: [
        { content: '推荐一本书', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '推荐了一本书' },
        { content: '推荐有质量的书', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '推荐内容低质' },
        { content: '推荐理由应合理', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '理由浮夸不切实际' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '请给我推荐一本好书。',
      '推荐《如何快速致富》，能让你一夜暴富。',
    ));
    assert.ok(r.score! <= 40, `expected <=40, got ${r.score}`);
  });

  it('用例4: 高度开放任务 → ≥90', async () => {
    inject(buildJudgeResult({
      overall_reason: '生成的五言绝句符合体裁要求，有意境，押韵合理。',
      explicit_completion_score: 100,
      implicit_constraint_score: 95,
      information_sufficiency_score: 95,
      requirement_results: [
        { content: '写一首诗', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '已生成诗歌' },
        { content: '符合诗歌体裁', type: 'implicit', confidence: 'high', verdict: 'covered', reason: '五言绝句格式正确' },
        { content: '内容合理', type: 'implicit', confidence: 'medium', verdict: 'covered', reason: '意境优美' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '随便写首诗。',
      '秋叶落纷纷，寒蝉切切吟。山空人迹少，日暮鸟归林。',
    ));
    assert.ok(r.score! >= 90, `expected >=90, got ${r.score}`);
  });

  it('用例5: 隐含约束违反——价格范围 → ≤40', async () => {
    inject(buildJudgeResult({
      overall_reason: '推荐价格远超大学生预算范围。',
      explicit_completion_score: 50,
      implicit_constraint_score: 10,
      information_sufficiency_score: 30,
      requirement_results: [
        { content: '推荐笔记本电脑', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '推荐了三款' },
        { content: '适合大学生', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '推荐了高端商务本' },
        { content: '性价比高（价格适中）', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '均价15000+远超出预算' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '推荐几款适合大学生的笔记本电脑，性价比要高。',
      '推荐三款高端商务本，均价15000元以上。',
    ));
    assert.ok(r.score! <= 40, `expected <=40, got ${r.score}`);
  });

  it('用例6: 低置信度约束未满足不严重扣分 → ≥70', async () => {
    inject(buildJudgeResult({
      overall_reason: '推荐了热映大片，虽未区分类型但整体质量可接受。',
      explicit_completion_score: 95,
      implicit_constraint_score: 80,
      information_sufficiency_score: 85,
      requirement_results: [
        { content: '推荐好看的电影', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '推荐了热映大片' },
        { content: '按类型区分', type: 'implicit', confidence: 'low', verdict: 'not_covered', reason: '未区分类型' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '最近有什么好看的电影？',
      '推荐几部热映大片：流浪地球3、封神2、热辣滚烫...',
    ));
    assert.ok(r.score! >= 70, `expected >=70, got ${r.score}`);
  });

  it('用例7: 多轮对话上下文依赖 → 100', async () => {
    inject(buildJudgeResult({
      overall_reason: '正确利用对话历史中的科幻偏好信息，推荐精准。',
      explicit_completion_score: 100,
      implicit_constraint_score: 100,
      information_sufficiency_score: 100,
      requirement_results: [
        { content: '推荐其他书籍', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '推荐了科幻经典' },
        { content: '推荐科幻类（利用前文上下文）', type: 'implicit', confidence: 'high', verdict: 'covered', reason: '正确识别了用户偏好' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '前文：我最近在看科幻小说。本轮：还有别的推荐吗？',
      '推荐《三体》《银河帝国》《神经漫游者》，都是科幻经典。',
    ));
    assert.equal(r.score, 100);
  });

  it('用例8: 信息充分性不足——过于片面 → ≤50', async () => {
    inject(buildJudgeResult({
      overall_reason: '回答存在明显偏向性，未客观对比两种语言。',
      explicit_completion_score: 50,
      implicit_constraint_score: 60,
      information_sufficiency_score: 20,
      requirement_results: [
        { content: '列出Java优缺点', type: 'explicit', confidence: 'high', verdict: 'partially_covered', reason: '只提了缺点' },
        { content: '列出Python优缺点', type: 'explicit', confidence: 'high', verdict: 'partially_covered', reason: '只提了优点' },
        { content: '客观对比', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '存在偏向性' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      'Java 和 Python 各有什么优缺点？',
      'Python 优点很多... Java 缺点很多...',
    ));
    assert.ok(r.score! <= 50, `expected <=50, got ${r.score}`);
  });

  it('用例9: 用户输入模糊 → ≥80', async () => {
    inject(buildJudgeResult({
      overall_reason: '输入模糊时合理请求澄清是最佳回应。',
      explicit_completion_score: 90,
      implicit_constraint_score: 90,
      information_sufficiency_score: 90,
      requirement_results: [
        { content: '处理用户请求', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '请求了澄清' },
        { content: '识别模糊输入', type: 'implicit', confidence: 'high', verdict: 'covered', reason: '正确识别输入模糊' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '帮我处理一下。',
      '请问您需要处理什么？请提供更多信息。',
    ));
    assert.ok(r.score! >= 80, `expected >=80, got ${r.score}`);
  });

  it('用例10: 需求清单长但充分覆盖 → 100', async () => {
    const reqs = Array.from({ length: 8 }, (_, i) => ({
      content: `问题${i + 1}`,
      type: 'explicit' as const,
      confidence: 'high' as const,
      verdict: 'covered' as const,
      reason: `已回答问题${i + 1}`,
    }));
    inject(buildJudgeResult({
      overall_reason: '逐一回答了全部8个问题，结构清晰。',
      explicit_completion_score: 100,
      implicit_constraint_score: 100,
      information_sufficiency_score: 100,
      requirement_results: reqs,
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '请回答以下8个问题...',
      '逐一回答了全部8个问题。',
    ));
    assert.equal(r.score, 100);
  });

  it('用例11: 隐含了情绪需求 → ≥85', async () => {
    inject(buildJudgeResult({
      overall_reason: '先回应情绪再解决问题，处理得当。',
      explicit_completion_score: 90,
      implicit_constraint_score: 90,
      information_sufficiency_score: 90,
      requirement_results: [
        { content: '解决系统问题', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '询问了具体问题' },
        { content: '回应情绪', type: 'implicit', confidence: 'high', verdict: 'covered', reason: '表达了理解和歉意' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '我真的快被这个系统气死了，每次都不好用！',
      '非常抱歉给您带来困扰，我理解您的心情。请问具体是哪个功能出了问题？我来帮您解决。',
    ));
    assert.ok(r.score! >= 85, `expected >=85, got ${r.score}`);
  });

  it('用例12: 多重遗漏叠加 → ≤40', async () => {
    inject(buildJudgeResult({
      overall_reason: '遗漏关键点、多列行动项、格式约束被违反。',
      explicit_completion_score: 20,
      implicit_constraint_score: 50,
      information_sufficiency_score: 30,
      requirement_results: [
        { content: '总结文档', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '已总结' },
        { content: '列出三个关键点', type: 'explicit', confidence: 'high', verdict: 'partially_covered', reason: '仅列了2个' },
        { content: '列出两个行动项', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '列了3个而非2个' },
        { content: '用表格输出', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '使用了段落而非表格' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '请总结一下这份文档，列出三个关键点和两个行动项，并用表格输出。',
      '段落总结...2个关键点...3个行动项...',
    ));
    assert.ok(r.score! <= 40, `expected <=40, got ${r.score}`);
  });

  it('破坏验证：分数不为常量', async () => {
    inject(buildJudgeResult({
      overall_reason: '部分完成',
      explicit_completion_score: 60,
      implicit_constraint_score: 70,
      information_sufficiency_score: 65,
      requirement_results: [
        { content: '需求1', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '已完成' },
        { content: '需求2', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '未完成' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx('测试', '输出'));
    // 60*0.5 + 70*0.3 + 65*0.2 = 30 + 21 + 13 = 64
    assert.ok(r.score! > 0 && r.score! < 100, `expected non-trivial score, got ${r.score}`);
  });
});
