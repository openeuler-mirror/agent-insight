import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { EvalPoint } from '../src/lib/evaluators/eval-output';
import { setJudgeLlmCallerForTest, type JudgeLlmRequest } from '../src/lib/engine/experiment/judge-llm';
import {
  configuredDeductionScore,
  deductionScore,
  defineTextJudgeDefinition,
  defineTextRiskAggregateConfig,
  TEXT_POINT_SCORES,
  type TextRiskAggregateConfig,
  type TextSeverity,
  type TextVerdict,
} from '../src/lib/engine/experiment/text-judge-common';
import {
  aggregateTextAiFlavorScore,
  AI_FLAVOR_POINT_SCORES,
} from '../src/lib/engine/experiment/text-ai-flavor-preset-evaluator';
import {
  aggregateTextConcisenessScore,
  CONCISENESS_POINT_SCORES,
  TEXT_CONCISENESS_WEIGHTS,
} from '../src/lib/engine/experiment/text-conciseness-preset-evaluator';
import { TEXT_FORMAT_RISK_CONFIG } from '../src/lib/engine/experiment/text-format-preset-evaluator';
import { TEXT_LANGUAGE_RISK_CONFIG } from '../src/lib/engine/experiment/text-language-consistency-preset-evaluator';
import { runTextPreset, type TextPresetId } from '../src/lib/engine/experiment/text-preset-evaluators';
import { presetEvaluators } from '../src/lib/evaluators/preset-evaluators';

const USER = 'text-evaluator-test';
const SEVERITIES = ['safe', 'minor', 'moderate', 'severe'] as const;
const dimensions: Record<TextPresetId, readonly string[]> = {
  'preset-text-ai-flavor': ['template_opening', 'template_closing', 'mechanical_transitions', 'generic_names', 'empty_summary', 'politeness_overuse'],
  'preset-text-format': ['numbering_continuity', 'citation_mark_correctness', 'list_hierarchy', 'punctuation_standardization', 'layout_consistency', 'tabular_format', 'special_format_correctness'],
  'preset-text-language-consistency': ['primary_language_match', 'unnecessary_mixing', 'code_switch_rationale', 'bilingual_handling'],
  'preset-text-conciseness': ['expression_efficiency', 'cliche_condensation', 'main_focus', 'information_completeness'],
};

type ExpectedFinding = { severity: TextSeverity; quote?: string };
type Fixture = {
  name: string;
  input?: string;
  output: string;
  findings?: Record<string, ExpectedFinding>;
  exact?: number;
  min?: number;
  max?: number;
};

const REQUIREMENT_FIXTURES: Record<TextPresetId, readonly Fixture[]> = {
  'preset-text-ai-flavor': [
    { name: '完全自然的文本', output: '今天约了老王打球，结果这货放我鸽子。算了，下次再说吧。', exact: 100 },
    { name: '模板化开篇 + 模板化结尾', output: '在当今这个信息技术飞速发展的时代，人工智能已经深刻改变了人们的生活方式。………综上所述，人工智能在带来便利的同时也带来了挑战，值得我们深思。', findings: { template_opening: { severity: 'moderate' }, template_closing: { severity: 'moderate' } }, max: 30 },
    { name: '机械连接词堆砌', output: '首先，我们需要了解问题的背景。其次，分析其产生的原因。再次，探讨可能的解决方案。最后，总结经验教训。值得注意的是，在实施过程中还需要考虑多方面因素。', findings: { mechanical_transitions: { severity: 'severe' } }, max: 30 },
    { name: '泛化人物名称', output: '小明和小红是一对好朋友。有一天，小明对小红说：我们去公园玩吧。小红高兴地答应了。', findings: { generic_names: { severity: 'severe' } }, max: 30 },
    { name: '空洞总结段落', output: '（长文论述后）总之，环境保护是一个非常重要的议题，关系到我们每个人的未来。我们应该共同努力，为子孙后代留下一个美好的家园。这不仅是一个责任，更是一种使命。', findings: { empty_summary: { severity: 'severe' } }, max: 30 },
    { name: '过度礼貌用语', output: '亲，您好呀～请问您需要什么样的帮助呢？随时都可以跟我说哦，不要客气啦～我会尽全力为您服务的呢～', findings: { politeness_overuse: { severity: 'severe' } }, max: 30 },
    { name: '边界——客服场景合理礼貌', input: '用户进入客服咨询', output: '您好，请问您需要什么帮助？请描述您遇到的问题，我会尽快为您处理。', findings: { politeness_overuse: { severity: 'minor' } }, min: 80 },
    { name: '多重 AI 味模式叠加', output: '在当今这个快速发展的时代，阅读越来越受到人们的重视。首先，阅读可以增长知识。其次，阅读可以开阔视野。再次，阅读可以陶冶情操。最后，阅读可以提升修养。总之，阅读是一种重要的学习方式，我们应该养成良好的阅读习惯。——小明同学，你觉得呢？', findings: { template_opening: { severity: 'moderate' }, mechanical_transitions: { severity: 'moderate' }, generic_names: { severity: 'moderate' }, empty_summary: { severity: 'moderate' } }, max: 20 },
    { name: '边界——技术文档自然表达', output: '执行 npm install 安装依赖，然后运行 npm run dev 启动开发服务器。如果遇到端口冲突，可以在 .env 中修改 PORT 环境变量。', exact: 100 },
    { name: '边界——短回复不易判断', output: '好的，马上处理。', min: 90 },
    { name: '几乎无 AI 味的自然写作', output: '昨天去看了一部新上映的电影，特效确实不错，但剧情有点老套。男主角的演技在线，可惜反派塑造太单薄了。整体来说值回票价，但不要期待太多惊喜。', min: 90 },
    { name: '高度 AI 味——全维度命中', output: '您好！很高兴为您服务。在当今这个充满挑战的市场环境下，企业数字化转型显得尤为重要。首先，数字化可以提高效率。其次，数字化可以降低成本。值得注意的是，转型过程中也需要关注数据安全。总之，数字化转型是一个复杂的系统工程，需要我们持续关注和努力。如果您还有任何疑问，欢迎随时联系我们。祝您生活愉快，工作顺利！', findings: { template_opening: { severity: 'moderate' }, template_closing: { severity: 'moderate' }, mechanical_transitions: { severity: 'moderate' }, empty_summary: { severity: 'moderate' }, politeness_overuse: { severity: 'moderate' } }, max: 20 },
    { name: '边界——仅有个别 AI 表达', output: '这篇文章写得不错，但字数有点少。值得注意的是，其中几个数据引用比较关键。', findings: { mechanical_transitions: { severity: 'minor' } }, min: 60, max: 80 },
    { name: '边界——引语使用非 AI 味', output: '正如老话说的，天下没有不散的筵席。翻译成英文就是 All good things must come to an end。', exact: 100 },
  ],
  'preset-text-format': [
    { name: '格式完全规范的文本', output: '一、项目背景\n本项目旨在提升系统性能。\n\n二、实施方案\n1. 需求分析\n2. 系统设计\n3. 开发实施\n4. 测试验证\n\n三、预期效果\n通过以上方案，预计性能提升 30%。', exact: 100 },
    { name: '序号跳号', output: '主要步骤：\n1. 打开设置\n3. 选择高级选项\n4. 保存配置\n6. 重启系统', findings: { numbering_continuity: { severity: 'severe' } }, max: 40 },
    { name: '引用标记不统一', output: '根据研究报告 [1]，该方法的有效性已达 95%¹。另有学者指出，该方法存在局限性²[3]。\n参考文献：\n[1] Smith et al.\n² Johnson et al.\n³ Lee et al.', findings: { citation_mark_correctness: { severity: 'severe' } }, max: 40 },
    { name: '列表层级混乱', output: '需求分类：\n1. 功能需求\n   a. 用户登录\n   b. 数据查询\n2. 性能需求\n   A. 响应时间 < 1s\n   b. 并发支持 1000 用户', findings: { list_hierarchy: { severity: 'severe' } }, max: 40 },
    { name: '中英文标点混用', output: '系统包括以下模块。(1)用户管理模块,负责用户的注册和登录.（2）权限管理模块，负责不同角色的访问控制。', findings: { punctuation_standardization: { severity: 'severe' } }, max: 40 },
    { name: '标题层级格式不统一', output: '# 第一章 概述\n\n## 1.1 背景\n一、问题分析\nA. 现状描述\nB. 痛点梳理', findings: { layout_consistency: { severity: 'severe' } }, max: 40 },
    { name: 'Markdown 表格格式错误', output: '| 姓名 | 年龄 | 城市\n| --- | --- | ---\n| 张三 | 25 | 北京 |\n| 李四 | 30 | 上海 |', findings: { tabular_format: { severity: 'moderate' } }, max: 50 },
    { name: '日期格式不统一', output: '项目于 2024-01-15 启动，第一阶段截止到 2024/03/20，第二阶段截止到 04/25/2024，最终交付日期为 2024 年 6 月 30 日。', findings: { special_format_correctness: { severity: 'moderate' } }, max: 50 },
    { name: '序号重复', output: '解决方案：\n1. 优化数据库查询\n2. 引入缓存机制\n2. 使用 CDN 加速\n3. 压缩静态资源', findings: { numbering_continuity: { severity: 'severe' } }, max: 40 },
    { name: '边界——纯文本无需格式检查', output: '今天天气不错，适合出去走走。', exact: 100 },
    { name: '成对标点不匹配', output: '他说道：「这个问题需要重视。然后继续讲解。', findings: { punctuation_standardization: { severity: 'moderate' } }, max: 50 },
    { name: '引用标记指向不存在的内容', output: '根据文献 [3] 的结论，该方法是有效的[1]。\n参考文献：\n[1] A\n[2] B', findings: { citation_mark_correctness: { severity: 'severe' } }, max: 40 },
    { name: '边界——代码块内格式不检查', output: '执行以下命令：\n```text\n1. npm install\n3. npm run build\n```\n命令执行完成后即可部署。', exact: 100 },
    { name: '多重格式问题叠加', output: '一.项目背景\n本项目的主要目标。(1)提升效率.(2)降低成本(3)改善体验\n\n技术方案\n2.1 架构设计\n2.2 模块划分\n2.2.1 前端模块\n2.2.1 后端模块', findings: { numbering_continuity: { severity: 'moderate' }, punctuation_standardization: { severity: 'moderate' }, layout_consistency: { severity: 'moderate' } }, max: 20 },
  ],
  'preset-text-language-consistency': [
    { name: '中-中完全一致', input: '今天天气怎么样？', output: '今天北京晴转多云，气温 25~30°C。', exact: 100 },
    { name: '英-英完全一致', input: 'What is the weather like today?', output: "Today in Beijing it's partly cloudy, 25~30°C.", exact: 100 },
    { name: '非必要语言混杂——中文回复插入完整英文句子', input: '请介绍一下这个产品的功能', output: '该产品具有三大核心功能。First, it supports real-time data synchronization. 其次，它提供了强大的数据分析能力。Finally, it has an intuitive user interface.', findings: { unnecessary_mixing: { severity: 'severe' } }, max: 30 },
    { name: '主语言错误——中文提问英文回复', input: '请问怎么登录系统？', output: "To log into the system, please enter your username and password on the login page. If you forget your password, click 'Forgot Password' to reset it.", findings: { primary_language_match: { severity: 'severe' } }, max: 10 },
    { name: '合理混用——技术术语不扣分', input: '这个 API 的响应时间太长了，怎么优化？', output: '您可以尝试以下优化方案：1. 使用 CDN 加速静态资源加载；2. 对数据库查询添加索引；3. 启用 Redis 缓存。另外建议检查服务器的 CPU 和内存使用情况。', exact: 100 },
    { name: '合理混用——人名和品牌名不扣分', input: '苹果的 iPhone 和 Google 的 Pixel 哪个好？', output: 'iPhone 的生态系统更完善，而 Google Pixel 的相机算法更出色。两者各有优势，具体取决于您的使用偏好。', exact: 100 },
    { name: '合理混用——寒暄语不扣分', input: '你好', output: 'Hello！您好，很高兴为您服务，请问有什么可以帮您的？', exact: 100 },
    { name: '双语用户——回复仅使用一种语言', input: 'How to reset password？另外，怎么查看我的账单 history？', output: '您可以在设置页面重置密码。账单历史可以在账户中心查看。', findings: { bilingual_handling: { severity: 'moderate' } }, max: 50 },
    { name: '合理语言切换——翻译对照', input: '“可持续发展”用英文怎么说？', output: '“可持续发展”的英文是 sustainable development（SD），是联合国 2030 年议程的核心概念之一。', exact: 100 },
    { name: '合理语言切换——引用外文原文', input: '牛顿第一定律的内容是什么？', output: "牛顿第一定律（Newton's First Law of Motion）指出：An object at rest stays at rest and an object in motion stays in motion with the same speed and in the same direction unless acted upon by an unbalanced force. 简单来说就是“惯性定律”。", exact: 100 },
    { name: '非必要中英文交替使用', input: '请介绍一下产品的价格方案', output: '我们提供了三种 pricing plans。Basic 版是免费的，适合个人用户。Pro 版本需要每个月支付 $29，适合 small business。Enterprise 版是 custom pricing，需要联系我们的 sales team。', findings: { unnecessary_mixing: { severity: 'severe' } }, max: 40 },
    { name: '边界——代码和技术文档中英语合理', input: '这段代码有什么问题？\nfunction check(value) { if (value = 1) return true; else return false; }', output: '代码中的问题如下：第 3 行的 if 条件判断使用了赋值运算符 = 而非比较运算符 ==，这会导致条件始终为真。建议将第 3 行的 = 改为 ==。', exact: 100 },
    { name: '同一概念中英文交替', input: '怎么配置这个工具？', output: '首先打开 configuration file，然后修改 database 的 connection string，接着重启 application server，最后检查 log 文件确认是否运行正常。', findings: { unnecessary_mixing: { severity: 'severe' } }, max: 30 },
    { name: '边界——用户提问语言模糊', input: 'Thank you 是什么意思？あいさつ的英文是什么？', output: '“Thank you”的中文意思是“谢谢你”。“あいさつ”（日语中的“问候”）对应的英文是“greeting”。', exact: 100 },
  ],
  'preset-text-conciseness': [
    { name: '高度简洁的回答', input: '怎么关闭自动更新？', output: '进入设置 > 系统 > 高级 > 关闭“自动更新”开关。', exact: 100 },
    { name: '表达冗余', input: '你叫什么名字？', output: '我的名字是叫做 AI 助手，这是一个非常动听的名字，我很喜欢这个名字。', findings: { expression_efficiency: { severity: 'severe' } }, max: 30 },
    { name: '偏离主需求扩写', input: '今天会下雨吗？', output: '根据气象部门发布的最新天气预报，受来自西伯利亚的冷空气和东南沿海暖湿气流共同影响，本市今日将迎来一次明显的降水过程。降水主要集中在下午时段，预计降水量在 10~20 毫米之间。另外提醒您，未来三天都将持续阴雨天气，请注意出行安全。', findings: { main_focus: { severity: 'severe' } }, max: 50 },
    { name: '套话过多', input: '这道题怎么做？', output: '您好！很高兴为您解答这道数学题。首先，非常感谢您向我提问，这是一个很有趣的问题。好的，现在让我们一起来看看这道题的解法。', findings: { cliche_condensation: { severity: 'severe' } }, max: 40 },
    { name: '边界——过度精简导致信息缺失', input: '怎么安装这个软件？', output: '下载安装包，双击运行，下一步，完成。', findings: { information_completeness: { severity: 'severe' } }, max: 50 },
    { name: '边界——需要一定长度才能解释清楚', input: '什么是递归？', output: '递归是函数调用自身的方法。它需要基线条件来停止，也需要递归条件逐步缩小问题。例如 factorial(n) 在 n≤1 时返回 1，否则返回 n×factorial(n-1)。实际使用时还要限制递归深度，避免栈溢出。', min: 80 },
    { name: '修饰词堆砌', output: '这是一个非常极其特别重要的、具有重大深远意义的、影响广泛的变革性创新。', findings: { expression_efficiency: { severity: 'severe' } }, max: 30 },
    { name: '边界——客服场景的合理长度', input: '我的快递丢件了！', output: '很抱歉给您带来困扰。我会立即登记丢件并联系承运网点核查，请提供运单号；我们会在 24 小时内反馈进展，确认丢失后按规则理赔。', min: 80 },
    { name: '背景铺垫过长', input: 'Python 和 Java 哪个快？', output: '编程语言经历了长期发展，不同语言有不同设计哲学。解释型语言和编译型语言的执行方式也不同。就多数 CPU 密集型任务而言，Java 通常比 Python 快。', findings: { main_focus: { severity: 'severe' } }, max: 40 },
    { name: '多重冗余叠加', output: '您好！很高兴收到您的问题。关于您问的这个话题，这是一个非常有趣且值得探讨的话题。首先，我想说的是，这个话题涉及很多方面，非常值得深入研究。其次，这个话题对我们的工作也很重要。最后，希望我的回答对您有帮助，如果有任何问题欢迎随时提问。', findings: { expression_efficiency: { severity: 'severe' }, cliche_condensation: { severity: 'severe' }, main_focus: { severity: 'severe' } }, max: 20 },
    { name: '边界——短回复自然简洁', input: '现在几点了？', output: '下午 2 点 30 分。', exact: 100 },
    { name: '信息完整但表述不够简洁', input: '如何创建文件夹？', output: '你可以用鼠标右键点击桌面或文件资源管理器中的空白区域，然后在弹出的右键菜单中把鼠标移动到“新建”选项上，接着在展开的子菜单中选择“文件夹”选项，最后输入文件夹的名称并按回车键确认。', findings: { expression_efficiency: { severity: 'moderate' } }, min: 50, max: 70 },
  ],
};

function ctx(output: string, input = '') {
  return {
    caseInput: input,
    actualOutput: output,
    referenceOutput: null,
    traceSummaryText: null,
    interactions: [],
    evaluatorContext: null,
    evaluatorContextError: null,
    taskId: null,
    executionId: null,
    user: USER,
    execution: null,
  };
}

function judgeJson(id: TextPresetId, findings: Record<string, ExpectedFinding> = {}, summary = '文字自然直接，未发现明显质量问题。') {
  return JSON.stringify({
    verdicts: dimensions[id].map((dimension) => {
      const finding = findings[dimension] ?? { severity: 'safe' as const };
      return {
        dimension,
        severity: finding.severity,
        quote: finding.severity === 'safe' ? '' : (finding.quote ?? '问题片段'),
        reason: finding.severity === 'safe' ? '' : `${dimension} 存在明确问题`,
        suggestion: finding.severity === 'safe' ? '' : `改写 ${dimension} 对应片段`,
      };
    }),
    summary,
  });
}

function expectedPointScore(id: TextPresetId, _dimension: string, severity: TextSeverity): number {
  if (id === 'preset-text-ai-flavor') return AI_FLAVOR_POINT_SCORES[severity];
  if (id === 'preset-text-conciseness') return CONCISENESS_POINT_SCORES[severity];
  return TEXT_POINT_SCORES[severity];
}

afterEach(() => setJudgeLlmCallerForTest(null));

describe('需求自带的 54 条文本质量用例', () => {
  for (const id of Object.keys(REQUIREMENT_FIXTURES) as TextPresetId[]) {
    for (const fixture of REQUIREMENT_FIXTURES[id]) {
      it(`${id}: ${fixture.name}`, async () => {
        let request: JudgeLlmRequest | undefined;
        setJudgeLlmCallerForTest(async (_user, currentRequest) => {
          request = currentRequest;
          return judgeJson(id, fixture.findings);
        });
        const output = await runTextPreset(id, USER, ctx(fixture.output, fixture.input));
        assert.ok(request, fixture.name);
        assert.equal(output.summary, '文字自然直接，未发现明显质量问题。');
        assert.equal(output.evidence, undefined, `${fixture.name}: 不应输出卡级 evidence`);
        assert.ok(request.user.includes(JSON.stringify(fixture.output)), `${fixture.name}: agent_output 未完整传入`);
        if (fixture.input !== undefined) assert.ok(request.user.includes(JSON.stringify(fixture.input)), `${fixture.name}: user_question 未完整传入`);
        for (const forbidden of ['在当今这个', '小明', '非常极其特别', 'configuration file', 'API、CPU']) {
          assert.ok(!request.system.includes(forbidden), `${fixture.name}: Prompt 包含验收题提示 ${forbidden}`);
        }
        assert.ok(request.system.includes('80 字以内的具体中文短结论'), `${fixture.name}: Prompt 缺少短总结约束`);

        assert.equal(typeof output.score, 'number', fixture.name);
        const score = output.score ?? -1;
        if (fixture.exact !== undefined) assert.equal(score, fixture.exact, fixture.name);
        if (fixture.min !== undefined) assert.ok(score >= fixture.min, `${fixture.name}: ${score} < ${fixture.min}`);
        if (fixture.max !== undefined) assert.ok(score <= fixture.max, `${fixture.name}: ${score} > ${fixture.max}`);

        assert.equal(output.points?.length, dimensions[id].length, fixture.name);
        for (const [index, dimension] of dimensions[id].entries()) {
          const point: EvalPoint | undefined = output.points?.[index];
          assert.ok(point, `${fixture.name}: 缺少 ${dimension} 评分点`);
          if (!point) continue;
          const severity = fixture.findings?.[dimension]?.severity ?? 'safe';
          assert.equal(point.score, expectedPointScore(id, dimension, severity), `${fixture.name}: ${dimension} 细则分错误`);
          assert.equal(point.status, severity === 'safe' ? 'covered' : severity === 'severe' ? 'missing' : 'partial');
          const evidence = point.evidence && 'md' in point.evidence ? point.evidence.md : '';
          if (severity === 'safe') {
            assert.equal(point.suggestion, undefined);
          } else {
            assert.match(evidence, new RegExp(dimension), `${fixture.name}: ${dimension} 缺少理由`);
            assert.match(evidence, /原文引用：/, `${fixture.name}: ${dimension} 缺少原文引用`);
            assert.match(point.suggestion ?? '', new RegExp(dimension), `${fixture.name}: ${dimension} 缺少 suggestion`);
            assert.ok(!evidence.includes('建议：'), `${fixture.name}: 建议应使用标准 suggestion 字段`);
          }
        }
      });
    }
  }
});

describe('文本评估器公式和输出契约', () => {
  it('文本评估器卡片使用面向场景的指定标签，其他标签保持不变', () => {
    const cards = new Map(presetEvaluators.map((card) => [card.id, card]));
    assert.deepEqual(cards.get('preset-text-ai-flavor')?.objectives, ['内容质量']);
    assert.deepEqual(cards.get('preset-text-format')?.objectives, ['内容质量']);
    assert.deepEqual(cards.get('preset-text-language-consistency')?.objectives, ['内容质量']);
    assert.deepEqual(cards.get('preset-text-conciseness')?.objectives, ['内容质量']);
    assert.deepEqual(cards.get('preset-text-ai-flavor')?.scenarios, ['客服对话', '内容创作']);
    assert.deepEqual(cards.get('preset-text-format')?.scenarios, ['报告生成', '内容创作']);
    assert.deepEqual(cards.get('preset-text-language-consistency')?.scenarios, ['双语对话', 'AI翻译']);
    assert.deepEqual(cards.get('preset-text-conciseness')?.scenarios, ['问答助手', '摘要生成']);
  });

  it('AI 味聚合按各档保留系数进行乘法累计，小项分映射保持独立', () => {
    const make = (severities: TextSeverity[]): TextVerdict[] => severities.map((severity, index) => ({
      dimension: `d${index}`,
      severity,
      quote: '',
      reason: '',
      suggestion: '',
    }));
    assert.equal(aggregateTextAiFlavorScore(make(['safe', 'safe', 'safe', 'safe', 'safe', 'safe'])), 100);
    assert.equal(aggregateTextAiFlavorScore(make(['minor', 'safe', 'safe', 'safe', 'safe', 'safe'])), 80);
    assert.equal(aggregateTextAiFlavorScore(make(['moderate', 'safe', 'safe', 'safe', 'safe', 'safe'])), 50);
    assert.equal(aggregateTextAiFlavorScore(make(['moderate', 'moderate', 'safe', 'safe', 'safe', 'safe'])), 25);
    assert.equal(aggregateTextAiFlavorScore(make(['severe', 'safe', 'safe', 'safe', 'safe', 'safe'])), 30);
    assert.equal(aggregateTextAiFlavorScore(make(['minor', 'minor', 'safe', 'safe', 'safe', 'safe'])), 64);
    assert.equal(aggregateTextAiFlavorScore(make(['moderate', 'moderate', 'moderate', 'minor', 'minor', 'safe'])), 8);
    assert.equal(aggregateTextAiFlavorScore(make(['severe', 'severe', 'severe', 'severe', 'severe', 'moderate'])), 1);
    assert.equal(aggregateTextAiFlavorScore(make(['severe', 'severe', 'severe', 'severe', 'severe', 'severe'])), 0);
    assert.deepEqual(AI_FLAVOR_POINT_SCORES, { safe: 100, minor: 80, moderate: 20, severe: 0 });
  });

  it('AI 味乘法聚合随任一维度升档时总分不升', () => {
    const base = dimensions['preset-text-ai-flavor'].map((dimension) => ({
      dimension,
      severity: 'safe' as TextSeverity,
      quote: '',
      reason: '',
      suggestion: '',
    }));
    for (const dimension of dimensions['preset-text-ai-flavor']) {
      let previous = 101;
      for (const severity of SEVERITIES) {
        const verdicts = base.map((verdict) => verdict.dimension === dimension ? { ...verdict, severity } : verdict);
        const score = aggregateTextAiFlavorScore(verdicts);
        assert.ok(score <= previous, `${dimension}: ${severity} 时 ${score} > ${previous}`);
        previous = score;
      }
    }
  });

  it('AI 味聚合仅在全部维度 severe 时归零', () => {
    const combinations = SEVERITIES.length ** dimensions['preset-text-ai-flavor'].length;
    for (let encoded = 0; encoded < combinations; encoded += 1) {
      let cursor = encoded;
      const severities = dimensions['preset-text-ai-flavor'].map(() => {
        const severity = SEVERITIES[cursor % SEVERITIES.length];
        cursor = Math.floor(cursor / SEVERITIES.length);
        return severity;
      });
      const verdicts = severities.map((severity, index) => ({
        dimension: `d${index}`,
        severity,
        quote: '',
        reason: '',
        suggestion: '',
      } satisfies TextVerdict));
      const score = aggregateTextAiFlavorScore(verdicts);
      assert.equal(score === 0, severities.every((severity) => severity === 'severe'), severities.join(','));
    }
  });

  it('需求 fixture 数量固定为 14 + 14 + 14 + 12 = 54', () => {
    assert.deepEqual(Object.values(REQUIREMENT_FIXTURES).map((fixtures) => fixtures.length), [14, 14, 14, 12]);
    assert.equal(Object.values(REQUIREMENT_FIXTURES).flat().length, 54);
  });

  it('共享扣分公式随任一维度升档时总分不升', () => {
    const base = dimensions['preset-text-ai-flavor'].map((dimension) => ({ dimension, severity: 'safe', quote: '', reason: '', suggestion: '' } satisfies TextVerdict));
    for (const dimension of dimensions['preset-text-ai-flavor']) {
      let previous = 101;
      for (const severity of SEVERITIES) {
        const verdicts = base.map((verdict) => verdict.dimension === dimension ? { ...verdict, severity } : verdict);
        const score = deductionScore(verdicts);
        assert.ok(score <= previous, `${dimension}: ${severity} 时 ${score} > ${previous}`);
        previous = score;
      }
    }
  });

  it('扣分聚合采用最大项完整扣除、其余项按维度数均摊追加', () => {
    const makeVerdicts = (severities: TextSeverity[]): TextVerdict[] => severities.map((severity, index) => ({
      dimension: `d${index}`,
      severity,
      quote: '',
      reason: '',
      suggestion: '',
    }));
    assert.equal(deductionScore(makeVerdicts(['safe', 'safe', 'safe', 'safe'])), 100);
    assert.equal(deductionScore(makeVerdicts(['minor', 'safe', 'safe', 'safe'])), 80);
    assert.equal(deductionScore(makeVerdicts(['moderate', 'safe', 'safe', 'safe'])), 20);
    assert.equal(deductionScore(makeVerdicts(['minor', 'minor', 'safe', 'safe'])), 75);
  });

  it('格式评估器关键维度比普通维度扣分更重', () => {
    const make = (dimension: string, severity: TextSeverity): TextVerdict[] => TEXT_FORMAT_RISK_CONFIG.dimensionKeys.map((key) => ({
      dimension: key,
      severity: key === dimension ? severity : 'safe',
      quote: '',
      reason: '',
      suggestion: '',
    }));
    assert.equal(configuredDeductionScore(make('numbering_continuity', 'minor'), TEXT_FORMAT_RISK_CONFIG), 80);
    assert.equal(configuredDeductionScore(make('punctuation_standardization', 'minor'), TEXT_FORMAT_RISK_CONFIG), 82);
    assert.equal(configuredDeductionScore(make('numbering_continuity', 'severe'), TEXT_FORMAT_RISK_CONFIG), 0);
    assert.equal(configuredDeductionScore(make('punctuation_standardization', 'severe'), TEXT_FORMAT_RISK_CONFIG), 10);
  });

  it('文本关键/普通聚合配置在模块加载期拒绝遗漏、重复和无关键维度', () => {
    assert.doesNotThrow(() => defineTextRiskAggregateConfig({
      dimensionKeys: ['critical', 'ordinary'],
      criticalDimensionKeys: ['critical'],
      ordinaryDimensionKeys: ['ordinary'],
    }));
    assert.throws(() => defineTextRiskAggregateConfig({
      dimensionKeys: ['critical', 'ordinary'],
      criticalDimensionKeys: ['critical'],
      ordinaryDimensionKeys: [],
    }));
    assert.throws(() => defineTextRiskAggregateConfig({
      dimensionKeys: ['critical', 'ordinary'],
      criticalDimensionKeys: ['critical', 'ordinary'],
      ordinaryDimensionKeys: ['ordinary'],
    }));
    assert.throws(() => configuredDeductionScore([], TEXT_FORMAT_RISK_CONFIG), /必须包含全部且仅包含/);
  });

  it('格式与语种真实配置在全部严重度组合下保持逐维单调', () => {
    const configs: readonly TextRiskAggregateConfig[] = [TEXT_FORMAT_RISK_CONFIG, TEXT_LANGUAGE_RISK_CONFIG];
    for (const config of configs) {
      const combinations = SEVERITIES.length ** config.dimensionKeys.length;
      for (let encoded = 0; encoded < combinations; encoded += 1) {
        let cursor = encoded;
        const levels = config.dimensionKeys.map(() => {
          const level = cursor % SEVERITIES.length;
          cursor = Math.floor(cursor / SEVERITIES.length);
          return level;
        });
        const verdicts = config.dimensionKeys.map((dimension, index) => ({
          dimension,
          severity: SEVERITIES[levels[index]],
          quote: '',
          reason: '',
          suggestion: '',
        } satisfies TextVerdict));
        const before = configuredDeductionScore(verdicts, config);
        for (const [index, level] of levels.entries()) {
          if (level === SEVERITIES.length - 1) continue;
          const upgraded = verdicts.map((verdict, verdictIndex) => verdictIndex === index
            ? { ...verdict, severity: SEVERITIES[level + 1] }
            : verdict);
          const after = configuredDeductionScore(upgraded, config);
          assert.ok(after <= before, `${config.dimensionKeys[index]}: ${before} -> ${after}`);
        }
      }
    }
  });

  it('语种关键/普通扣分和简洁性加权公式均保持单调', () => {
    for (const id of ['preset-text-language-consistency', 'preset-text-conciseness'] as const) {
      const base = dimensions[id].map((dimension) => ({ dimension, severity: 'safe', quote: '', reason: '', suggestion: '' } satisfies TextVerdict));
      for (const dimension of dimensions[id]) {
        let previous = 101;
        for (const severity of SEVERITIES) {
          const verdicts = base.map((verdict) => verdict.dimension === dimension ? { ...verdict, severity } : verdict);
          const score = id === 'preset-text-language-consistency'
            ? configuredDeductionScore(verdicts, TEXT_LANGUAGE_RISK_CONFIG)
            : aggregateTextConcisenessScore(verdicts);
          assert.ok(score <= previous, `${id}/${dimension}: ${severity} 时 ${score} > ${previous}`);
          previous = score;
        }
      }
    }
  });

  it('语种一致性将主语言匹配设为关键维度，其余维度为普通维度', () => {
    assert.deepEqual(TEXT_LANGUAGE_RISK_CONFIG.criticalDimensionKeys, ['primary_language_match']);
    assert.deepEqual(TEXT_LANGUAGE_RISK_CONFIG.ordinaryDimensionKeys, [
      'unnecessary_mixing',
      'code_switch_rationale',
      'bilingual_handling',
    ]);
    const make = (dimension: string, severity: TextSeverity): TextVerdict[] => TEXT_LANGUAGE_RISK_CONFIG.dimensionKeys.map((key) => ({
      dimension: key,
      severity: key === dimension ? severity : 'safe',
      quote: '',
      reason: '',
      suggestion: '',
    }));
    assert.equal(configuredDeductionScore(make('primary_language_match', 'severe'), TEXT_LANGUAGE_RISK_CONFIG), 0);
    assert.equal(configuredDeductionScore(make('unnecessary_mixing', 'severe'), TEXT_LANGUAGE_RISK_CONFIG), 10);
  });

  it('语种切换合理性使用新的中文维度名称，内部 key 保持兼容', async () => {
    setJudgeLlmCallerForTest(async () => judgeJson('preset-text-language-consistency'));
    const output = await runTextPreset(
      'preset-text-language-consistency',
      USER,
      ctx('回复内容', '用户问题'),
    );
    assert.equal(output.points?.[2]?.label, '语种切换合理性');
  });

  it('简洁性使用需求权重的加权算术平均，并向最低维度收敛', () => {
    assert.deepEqual(TEXT_CONCISENESS_WEIGHTS, {
      expression_efficiency: 0.3,
      cliche_condensation: 0.2,
      main_focus: 0.3,
      information_completeness: 0.2,
    });
    const make = (severity: TextSeverity, dimension = 'expression_efficiency'): TextVerdict[] => dimensions['preset-text-conciseness'].map((key) => ({
      dimension: key,
      severity: key === dimension ? severity : 'safe',
      quote: '',
      reason: '',
      suggestion: '',
    }));
    assert.equal(aggregateTextConcisenessScore(make('safe')), 100);
    assert.equal(aggregateTextConcisenessScore(make('severe')), 18);
    assert.equal(aggregateTextConcisenessScore(make('moderate')), 59);
    assert.equal(aggregateTextConcisenessScore(make('minor')), 84);
    assert.equal(aggregateTextConcisenessScore(make('moderate', 'information_completeness')), 60);
    assert.equal(CONCISENESS_POINT_SCORES.moderate, 50);
  });

  it('细则 0 分被完整保留，summary 被压缩到 80 字以内', async () => {
    setJudgeLlmCallerForTest(async () => judgeJson(
      'preset-text-conciseness',
      { expression_efficiency: { severity: 'severe' } },
      '这是一段非常长的总结，用于验证系统会在共享实现中进行确定性截断，并且最终长度不会超过八十个字符，同时仍然保留足够的信息让使用者理解最重要的问题，而不是把多项评分细则全部罗列在卡片顶部。',
    ));
    const output = await runTextPreset('preset-text-conciseness', USER, ctx('冗余回复', '请简洁回答'));
    assert.equal(output.points?.[0]?.score, 0);
    assert.ok((output.summary?.length ?? 0) <= 80);
  });

  it('语种一致性缺少用户问题时 fail fast，且不得调用 Judge', async () => {
    let called = false;
    setJudgeLlmCallerForTest(async () => { called = true; return '{}'; });
    await assert.rejects(
      runTextPreset('preset-text-language-consistency', USER, ctx('Hello', '   ')),
      /需要非空用户问题/,
    );
    assert.equal(called, false);
  });

  it('未知、重复、缺失维度、空总结及无证据的非 safe verdict 均失败', async () => {
    const valid = JSON.parse(judgeJson('preset-text-ai-flavor')) as { verdicts: Array<Record<string, string>>; summary: string };
    const invalids = [
      { ...valid, verdicts: [...valid.verdicts, { ...valid.verdicts[0], dimension: 'unknown' }] },
      { ...valid, verdicts: [...valid.verdicts, { ...valid.verdicts[0] }] },
      { ...valid, verdicts: valid.verdicts.slice(1) },
      { ...valid, summary: '' },
      { ...valid, verdicts: valid.verdicts.map((verdict, index) => index === 0 ? { ...verdict, severity: 'moderate', quote: '', reason: '', suggestion: '' } : verdict) },
    ];
    for (const invalid of invalids) {
      setJudgeLlmCallerForTest(async () => JSON.stringify(invalid));
      await assert.rejects(runTextPreset('preset-text-ai-flavor', USER, ctx('待评估文本')));
    }
  });

  it('格式 Judge 明确区分可追溯的引用样式差异与引用断开', async () => {
    let request: JudgeLlmRequest | undefined;
    setJudgeLlmCallerForTest(async (_user, currentRequest) => {
      request = currentRequest;
      return judgeJson('preset-text-format');
    });
    await runTextPreset('preset-text-format', USER, ctx('根据资料 [1]，结论成立。\n[1] 示例资料'));
    assert.deepEqual(request?.modelOptions, { temperature: 0 });
    assert.match(request?.system ?? '', /引用样式不统一.*minor/);
    assert.match(request?.system ?? '', /引用目标不存在.*moderate.*severe/);
  });

  it('四个文本 Judge 使用可泛化的豁免顺序和严重度锚点', async () => {
    const prompts = new Map<TextPresetId, string>();
    for (const id of Object.keys(REQUIREMENT_FIXTURES) as TextPresetId[]) {
      setJudgeLlmCallerForTest(async (_user, request) => {
        prompts.set(id, request.system);
        return judgeJson(id);
      });
      await runTextPreset(id, USER, ctx('通用待评估文本', '通用用户问题'));
    }

    for (const prompt of prompts.values()) {
      assert.match(prompt, /先完整应用边界与豁免/);
      assert.match(prompt, /不得用已豁免内容作为非 safe/);
      assert.match(prompt, /逐一独立检查全部维度/);
      assert.match(prompt, /“必须判”或“至少判”.*满足锚点时不得自行降档/);
      assert.match(prompt, /输出前最终复核/);
      assert.match(prompt, /初步判断与专用锚点冲突.*修正 severity/);
      assert.match(prompt, /文字结论为 safe、字段却为 minor\/moderate\/severe.*自相矛盾/);
    }

    const aiFlavor = prompts.get('preset-text-ai-flavor') ?? '';
    assert.match(aiFlavor, /孤立出现一次.*公式化元话语.*mechanical_transitions 必须判 minor/);
    assert.match(aiFlavor, /开头和结尾.*template_opening 与 template_closing 都至少判 moderate/);
    assert.match(aiFlavor, /占位式默认姓名.*generic_names 必须判 severe/);

    const format = prompts.get('preset-text-format') ?? '';
    assert.match(format, /重复编号.*至少判 numbering_continuity 为 moderate/);
    assert.match(format, /不同层级采用不同编号体系.*列表项或操作步骤/);
    assert.match(format, /系统性混用.*punctuation_standardization 至少判 moderate/);
    assert.match(format, /成对标点只有开符号而没有闭符号.*至少判 moderate/);
    assert.match(format, /标题或小节标题.*三种及以上不兼容标记族.*layout_consistency 为 severe/);
    assert.match(format, /严格 Markdown 表格规范.*完整的起止列界.*tabular_format 至少判 moderate/);
    assert.match(format, /Markdown 标题标记与不缩进的中文序号标题.*layout_consistency 必须判 severe/);
    assert.match(format, /三种及以上互不兼容的表示法.*special_format_correctness 至少判 moderate/);
    assert.match(format, /成对三反引号或三波浪线.*边界内部.*强制豁免/);
    assert.match(format, /理由或总结.*围栏代码块内.*severity 字段必须填写 safe/);

    const language = prompts.get('preset-text-language-consistency') ?? '';
    assert.match(language, /外语内容全部属于豁免.*unnecessary_mixing.*code_switch_rationale 必须判 safe/);
    assert.match(language, /成熟本地译名.*必须判 unnecessary_mixing 为 severe/);
    assert.match(language, /逐字引用外文资料.*相邻位置已用主语言说明.*必须判 safe/);
    assert.match(language, /少量通用外语寒暄.*必须将 unnecessary_mixing.*判 safe/);
    assert.match(language, /两种语言提出彼此独立.*bilingual_handling 至少判 moderate/);
    assert.match(language, /概念名称、简要释义、概括或转述.*必须判 safe/);
    assert.match(language, /知识性问答中.*原文引述.*具备引用理由/);

    const conciseness = prompts.get('preset-text-conciseness') ?? '';
    assert.match(conciseness, /简单事实问题.*其余内容只重复、修饰或主观评价.*expression_efficiency 为 severe/);
    assert.match(conciseness, /没有 user_question.*同义强化词.*expression_efficiency 为 severe/);
    assert.match(conciseness, /答案没有在开头明确给出.*占据回复主要篇幅.*main_focus 为 severe/);
    assert.match(conciseness, /二元判断或单一事实.*两类及以上可删除的非必要信息.*main_focus 为 severe/);
    assert.match(conciseness, /reason 或 summary.*答案被多句背景延后.*main_focus.*severe/);
    assert.match(conciseness, /缺少两类及以上信息.*information_completeness 为 severe/);
    assert.match(conciseness, /任何产品都适用的通用界面动作.*information_completeness 必须判 severe/);
    assert.match(conciseness, /大部分从句.*导航或点击动作.*expression_efficiency 必须判 moderate/);
    assert.match(conciseness, /简单比较或单一事实问题.*占回复文字的一半或以上.*main_focus 必须判 severe/);
    assert.match(conciseness, /没有实质性回答或可执行内容.*main_focus.*severe/);
    assert.match(conciseness, /整体压缩成简短操作路径.*expression_efficiency 为 moderate/);
    assert.match(conciseness, /不得仅因缺少可选替代方案.*information_completeness/);
  });

  it('配置定义在模块加载期拒绝空维度、重复 key 和越界细则分', () => {
    const base = {
      id: 'test-text', title: '测试文本评估器', rules: [], boundaryRules: [],
      buildInput: () => '{}', aggregate: () => 100,
    };
    assert.throws(() => defineTextJudgeDefinition({ ...base, dimensions: [] }), /至少需要一个维度/);
    assert.throws(() => defineTextJudgeDefinition({ ...base, dimensions: [{ key: 'a', label: 'A', description: '' }, { key: 'a', label: 'B', description: '' }] }), /重复维度/);
    assert.throws(() => defineTextJudgeDefinition({ ...base, dimensions: [{ key: 'a', label: 'A', description: '' }], pointScore: { safe: 101, minor: 80, moderate: 50, severe: 20 } }), /必须位于 0-100/);
  });
});
