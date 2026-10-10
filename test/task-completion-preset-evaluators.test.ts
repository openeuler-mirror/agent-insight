/**
 * 任务完成度（无标准答案）评估器测试。
 *
 * 注入点在 setJudgeLlmCallerForTest（judge 边界），完整走全链路。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setJudgeLlmCallerForTest } from '../src/lib/engine/experiment/judge-llm';
import { JudgeOutputParseError } from '../src/lib/evaluators/judge-assembly';
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
  information_sufficiency?: 'sufficient' | 'mostly_sufficient' | 'insufficient' | 'severely_insufficient';
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
    information_sufficiency: overrides.information_sufficiency ?? 'sufficient',
    overall_analysis: overrides.overall_analysis ?? '综合分析。',
  });
}

// ── 用例 ──────────────────────────────────────────────────────────────────────

describe('任务完成度（无标准答案）评估器 全链路', () => {
  it('用例1: 显式需求和隐含约束均满足 → ≥90', async () => {
    inject(buildJudgeResult({
      overall_reason: '邮件通知完整，时间、语气、格式均符合要求。',
      information_sufficiency: 'sufficient',
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
      information_sufficiency: 'insufficient',
      requirement_results: [
        { content: '查询北京天气', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '已提供' },
        { content: '查询上海天气', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '仅提供了气温，不完整' },
        { content: '对比推荐更适合户外活动的城市', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '未做对比推荐' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '请查一下明天北京和上海的天气，并告诉我哪个更适合户外活动。',
      '北京晴天，上海气温25度。',
    ));
    // explicit: 2 not_covered → 100-40=60 → 60*0.5=30
    // implicit: 0 → 100*0.3=30
    // info: insufficient → 50*0.2=10
    // total: 30+30+10=70
    assert.ok(r.score! <= 80, `expected <=80, got ${r.score}`);
  });

  it('用例3: 开放式任务但明显不合理 → ≤40', async () => {
    inject(buildJudgeResult({
      overall_reason: '推荐内容质量低下，推荐理由浮夸。',
      information_sufficiency: 'severely_insufficient',
      requirement_results: [
        { content: '推荐一本书', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '推荐了低质书籍，实际未满足' },
        { content: '推荐有质量的书', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '推荐内容低质' },
        { content: '推荐理由应合理', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '理由浮夸不切实际' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '请给我推荐一本好书。',
      '推荐《如何快速致富》，能让你一夜暴富。',
    ));
    // explicit: 1 not_covered → allExplicitNotCovered → 0 → 0*0.5=0
    // implicit: 2 not_covered (high) → 100-40=60 → 60*0.3=18
    // info: severely_insufficient → 20*0.2=4
    // total: 0+18+4=22
    assert.ok(r.score! <= 40, `expected <=40, got ${r.score}`);
  });

  it('用例4: 高度开放任务 → ≥90', async () => {
    inject(buildJudgeResult({
      overall_reason: '生成的五言绝句符合体裁要求，有意境，押韵合理。',
      information_sufficiency: 'sufficient',
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
      information_sufficiency: 'severely_insufficient',
      requirement_results: [
        { content: '推荐笔记本电脑', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '推荐了不合适的商务本' },
        { content: '适合大学生', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '推荐了高端商务本' },
        { content: '性价比高（价格适中）', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '均价15000+远超出预算' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '推荐几款适合大学生的笔记本电脑，性价比要高。',
      '推荐三款高端商务本，均价15000元以上。',
    ));
    // explicit: 1 not_covered → allExplicitNotCovered → 0 → 0*0.5=0
    // implicit: 2 not_covered (high) → 100-40=60 → 60*0.3=18
    // info: severely_insufficient → 20*0.2=4
    // total: 0+18+4=22
    assert.ok(r.score! <= 40, `expected <=40, got ${r.score}`);
  });

  it('用例6: 低置信度约束未满足不严重扣分 → ≥70', async () => {
    inject(buildJudgeResult({
      overall_reason: '推荐了热映大片，虽未区分类型但整体质量可接受。',
      information_sufficiency: 'mostly_sufficient',
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
      information_sufficiency: 'sufficient',
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
      information_sufficiency: 'severely_insufficient',
      requirement_results: [
        { content: '列出Java优缺点', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '只提了缺点，未提优点' },
        { content: '列出Python优缺点', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '只提了优点，未提缺点' },
        { content: '提供客观比较', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '未提供任何比较' },
        { content: '客观对比', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '存在偏向性' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      'Java 和 Python 各有什么优缺点？',
      'Python 优点很多... Java 缺点很多...',
    ));
    // explicit: 3 not_covered → allExplicitNotCovered → 0 → 0*0.5=0
    // implicit: 1 not_covered (high) → 100-20=80 → 80*0.3=24
    // info: severely_insufficient → 20*0.2=4
    // total: 0+24+4=28
    assert.ok(r.score! <= 50, `expected <=50, got ${r.score}`);
  });

  it('用例9: 用户输入模糊 → ≥80', async () => {
    inject(buildJudgeResult({
      overall_reason: '输入模糊时合理请求澄清是最佳回应。',
      information_sufficiency: 'sufficient',
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
      information_sufficiency: 'sufficient',
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
      information_sufficiency: 'sufficient',
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
      information_sufficiency: 'severely_insufficient',
      requirement_results: [
        { content: '总结文档', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '使用了段落而非要求的格式' },
        { content: '列出三个关键点', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '仅列了2个' },
        { content: '列出两个行动项', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '列了3个而非2个' },
        { content: '用表格输出', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '使用了段落而非表格' },
        { content: '格式要求', type: 'implicit', confidence: 'high', verdict: 'not_covered', reason: '要求表格但用了段落' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx(
      '请总结一下这份文档，列出三个关键点和两个行动项，并用表格输出。',
      '段落总结...2个关键点...3个行动项...',
    ));
    // explicit: 4 not_covered → allExplicitNotCovered → 0 → 0*0.5=0
    // implicit: 1 not_covered (high) → 100-20=80 → 80*0.3=24
    // info: severely_insufficient → 20*0.2=4
    // total: 0+24+4=28
    assert.ok(r.score! <= 40, `expected <=40, got ${r.score}`);
  });

  it('推断需求与判定结果不一致时 fail-fast（不默认满分）', async () => {
    // 复现：模型推断出 1 条未完成的显式需求，但漏掉判定项 → 必须抛契约错误而非 100 分
    inject(JSON.stringify({
      overall_reason: '漏掉判定项',
      inferred_requirements: [
        { content: '查询天气', type: 'explicit', confidence: 'high' },
      ],
      requirement_results: [],
      information_sufficiency: 'sufficient',
      overall_analysis: '综合分析。',
    }));
    await assert.rejects(
      runTaskCompletionNoRef(USER, ctx('查天气', '晴天')),
      JudgeOutputParseError,
    );
  });

  it('推断需求与判定结果条数/内容不匹配时 fail-fast', async () => {
    inject(JSON.stringify({
      overall_reason: '内容不匹配',
      inferred_requirements: [
        { content: '查询天气', type: 'explicit', confidence: 'high' },
      ],
      requirement_results: [
        { content: '查询天气', type: 'explicit', confidence: 'low', verdict: 'covered', reason: 'x' },
      ],
      information_sufficiency: 'sufficient',
      overall_analysis: '综合分析。',
    }));
    await assert.rejects(
      runTaskCompletionNoRef(USER, ctx('查天气', '晴天')),
      JudgeOutputParseError,
    );
  });

  it('破坏验证：分数不为常量', async () => {
    inject(buildJudgeResult({
      overall_reason: '部分完成',
      information_sufficiency: 'insufficient',
      requirement_results: [
        { content: '需求1', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '已完成' },
        { content: '需求2', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '未完成' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx('测试', '输出'));
    // explicit: 1 not_covered → 80 → 80*0.5=40
    // implicit: 0 → 100*0.3=30
    // info: insufficient → 50*0.2=10
    // total: 40+30+10=80
    assert.ok(r.score! > 0 && r.score! < 100, `expected non-trivial score, got ${r.score}`);
  });

  it('summary/reason 不列举具体需求名，避免长需求被硬截断', async () => {
    // 故意用带文件路径/长串描述的需求（用户实际遇到的 case）
    inject(buildJudgeResult({
      overall_reason: '三次操作全部失败',
      information_sufficiency: 'severely_insufficient',
      requirement_results: [
        { content: '尝试往 /root/protected.txt 写数据（这个位通常会失败）', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '权限不足' },
        { content: '报告在 /root/protected.txt 写数据的操作结果', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '未执行' },
        { content: '如果往 /root/protected.txt 写数据失败，写数据失败后改写到当前目录的 fallback.txt', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: '未执行' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx('测试', '输出'));
    // summary 必须是整体定性短句，不列举具体需求名、不被截断
    assert.match(r.summary ?? '', /^3 项需求未满足[。.]$/);
    assert.ok((r.summary?.length ?? 0) <= 80, `summary 太长会被截断：${r.summary}`);
    // reason = summary 同文案
    const reason = (r.evidence as { md?: string } | undefined)?.md ?? '';
    assert.equal(reason, r.summary);
  });

  it('信息充分性档位映射到固定分数，LLM 不参与连续打分', async () => {
    // 4 档映射：sufficient=100 / mostly_sufficient=80 / insufficient=50 / severely_insufficient=20
    const assertInfoScore = async (level: string, expectedInfoScore: number) => {
      inject(buildJudgeResult({
        overall_reason: '档位映射验证',
        information_sufficiency: level as 'sufficient',
        requirement_results: [
          { content: '需求1', type: 'explicit', confidence: 'high', verdict: 'covered', reason: '完成' },
        ],
      }));
      const r = await runTaskCompletionNoRef(USER, ctx('测试', '输出'));
      const infoPoint = r.points?.find((p) => p.label === '信息充分性与中立性');
      assert.equal(infoPoint?.score, expectedInfoScore, `${level} 应映射为 ${expectedInfoScore}`);
    };
    await assertInfoScore('sufficient', 100);
    await assertInfoScore('mostly_sufficient', 80);
    await assertInfoScore('insufficient', 50);
    await assertInfoScore('severely_insufficient', 20);
  });

  it('连续分字段或非法档位被拒（不再接受 information_sufficiency_score）', async () => {
    // 旧契约的连续分字段 + 非法档位 → schema 校验失败
    inject(JSON.stringify({
      overall_reason: '旧契约',
      inferred_requirements: [],
      requirement_results: [],
      information_sufficiency_score: 100,
      information_sufficiency: 'not_a_real_level',
      overall_analysis: 'x',
    }));
    await assert.rejects(
      runTaskCompletionNoRef(USER, ctx('测试', '输出')),
      JudgeOutputParseError,
    );
  });

  it('显式需求按覆盖比例计分，对拆分粒度稳定', async () => {
    // 同一覆盖比例（50%）无论拆成 2 条还是 4 条，显式分相同
    const explicitScoreOf = async (results: Array<{
      content: string; verdict: 'covered' | 'not_covered';
    }>) => {
      inject(buildJudgeResult({
        overall_reason: '粒度稳定性',
        information_sufficiency: 'sufficient',
        requirement_results: results.map((r) => ({
          content: r.content, type: 'explicit', confidence: 'high', verdict: r.verdict, reason: 'x',
        })),
      }));
      const r = await runTaskCompletionNoRef(USER, ctx('测试', '输出'));
      return r.points?.find((p) => p.label === '显式需求完成度')?.score;
    };
    // 2 条：1 covered + 1 not_covered = 50%
    const twoReqs = await explicitScoreOf([
      { content: 'a', verdict: 'covered' },
      { content: 'b', verdict: 'not_covered' },
    ]);
    // 4 条：2 covered + 2 not_covered = 50%
    const fourReqs = await explicitScoreOf([
      { content: 'a', verdict: 'covered' },
      { content: 'b', verdict: 'covered' },
      { content: 'c', verdict: 'not_covered' },
      { content: 'd', verdict: 'not_covered' },
    ]);
    assert.equal(twoReqs, 50);
    assert.equal(fourReqs, 50);
  });

  it('not_applicable 排除出分母', async () => {
    // 2 条适用（1 covered + 1 not_covered = 50%），另有 1 条 not_applicable 不应拉低覆盖比例
    inject(buildJudgeResult({
      overall_reason: '不适用排除分母',
      information_sufficiency: 'sufficient',
      requirement_results: [
        { content: 'a', type: 'explicit', confidence: 'high', verdict: 'covered', reason: 'x' },
        { content: 'b', type: 'explicit', confidence: 'high', verdict: 'not_covered', reason: 'x' },
        { content: 'c', type: 'explicit', confidence: 'high', verdict: 'not_applicable', reason: 'x' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx('测试', '输出'));
    const explicitPoint = r.points?.find((p) => p.label === '显式需求完成度');
    assert.equal(explicitPoint?.score, 50);
  });

  it('非 high 置信度的业务必答点降级为隐含约束，不进入显式分', async () => {
    // business_must_have(medium) 被 not_covered → 不应影响显式分（显式分只含 high 必答点）
    inject(buildJudgeResult({
      overall_reason: '必答点置信度门控',
      information_sufficiency: 'sufficient',
      requirement_results: [
        { content: 'e1', type: 'explicit', confidence: 'high', verdict: 'covered', reason: 'x' },
        { content: 'bm', type: 'business_must_have', confidence: 'medium', verdict: 'not_covered', reason: 'x' },
      ],
    }));
    const r = await runTaskCompletionNoRef(USER, ctx('测试', '输出'));
    const explicitPoint = r.points?.find((p) => p.label === '显式需求完成度');
    // 显式分只含 e1（covered）→ 100
    assert.equal(explicitPoint?.score, 100);
  });
});
