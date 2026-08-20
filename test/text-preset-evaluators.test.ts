import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setJudgeLlmCallerForTest } from '../src/lib/engine/experiment/judge-llm';
import { runTextPreset } from '../src/lib/engine/experiment/text-preset-evaluators';

const USER = 'text-evaluator-test';
const ctx = (output: string, input = '') => ({
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
});

const dimensions: Record<string, string[]> = {
  'preset-text-ai-flavor': ['template_opening', 'template_closing', 'mechanical_transitions', 'generic_names', 'empty_summary', 'politeness_overuse'],
  'preset-text-format': ['numbering_continuity', 'citation_mark_correctness', 'list_hierarchy', 'punctuation_standardization', 'layout_consistency', 'tabular_format', 'special_format_correctness'],
  'preset-text-language-consistency': ['primary_language_match', 'unnecessary_mixing', 'code_switch_rationale', 'bilingual_handling'],
  'preset-text-conciseness': ['expression_efficiency', 'cliche_condensation', 'main_focus', 'information_completeness'],
};

function judgeJson(id: string, findings: Record<string, { severity: string; quote?: string; reason?: string; suggestion?: string }> = {}) {
  return JSON.stringify({
    verdicts: dimensions[id].map((dimension) => {
      const f = findings[dimension] ?? { severity: 'safe' };
      return {
        dimension,
        severity: f.severity,
        quote: f.quote ?? (f.severity === 'safe' ? '' : '问题片段'),
        reason: f.reason ?? (f.severity === 'safe' ? '' : '发现该维度问题'),
        suggestion: f.suggestion ?? (f.severity === 'safe' ? '' : '请改写该片段'),
      };
    }),
    summary: '总体结论',
  });
}

function inject(text: string) {
  setJudgeLlmCallerForTest(async () => text);
}

afterEach(() => setJudgeLlmCallerForTest(null));

describe('文本 AI 味检查', () => {
  it('自然文本满分', async () => {
    inject(judgeJson('preset-text-ai-flavor'));
    assert.equal((await runTextPreset('preset-text-ai-flavor', USER, ctx('今天约了老王打球，结果这货放我鸽子。'))).score, 100);
  });
  it('泛化名称严重问题显著扣分', async () => {
    inject(judgeJson('preset-text-ai-flavor', { generic_names: { severity: 'severe', quote: '小明和小红', reason: '使用泛化默认人名', suggestion: '改用有语境的真实名称' } }));
    assert.equal((await runTextPreset('preset-text-ai-flavor', USER, ctx('小明和小红是一对好朋友。'))).score, 20);
  });
  it('多个模板问题叠加到低分', async () => {
    inject(judgeJson('preset-text-ai-flavor', {
      template_opening: { severity: 'moderate' }, template_closing: { severity: 'moderate' },
      mechanical_transitions: { severity: 'moderate' }, empty_summary: { severity: 'moderate' },
    }));
    assert.ok((await runTextPreset('preset-text-ai-flavor', USER, ctx('在当今时代。首先……总之……'))).score <= 20);
  });
});

describe('文本格式规范性', () => {
  it('纯文本无需格式检查', async () => {
    inject(judgeJson('preset-text-format'));
    assert.equal((await runTextPreset('preset-text-format', USER, ctx('今天天气不错，适合出去走走。'))).score, 100);
  });
  it('序号/引用等严重问题叠加', async () => {
    inject(judgeJson('preset-text-format', {
      numbering_continuity: { severity: 'severe' }, citation_mark_correctness: { severity: 'severe' },
      layout_consistency: { severity: 'moderate' }, punctuation_standardization: { severity: 'moderate' },
    }));
    assert.ok((await runTextPreset('preset-text-format', USER, ctx('1. a\n3. b [3]'))).score <= 20);
  });
  it('单个 Markdown 表格问题约为中低分', async () => {
    inject(judgeJson('preset-text-format', { tabular_format: { severity: 'moderate', quote: '| 姓名 |', reason: '表头分隔符不完整', suggestion: '补齐表格边界分隔符' } }));
    assert.equal((await runTextPreset('preset-text-format', USER, ctx('| 姓名 | 年龄\n| --- | ---'))).score, 50);
  });
});

describe('文本语种一致性', () => {
  it('中问中答与合理术语混用满分', async () => {
    inject(judgeJson('preset-text-language-consistency'));
    assert.equal((await runTextPreset('preset-text-language-consistency', USER, ctx('可以启用 Redis 缓存。', '这个 API 怎么优化？'))).score, 100);
  });
  it('完全错语种不超过 10 分', async () => {
    inject(judgeJson('preset-text-language-consistency', { primary_language_match: { severity: 'severe' } }));
    assert.equal((await runTextPreset('preset-text-language-consistency', USER, ctx('To log into the system.', '请问怎么登录？'))).score, 10);
  });
  it('非必要完整英文句子不超过 30 分', async () => {
    inject(judgeJson('preset-text-language-consistency', { unnecessary_mixing: { severity: 'severe' } }));
    assert.equal((await runTextPreset('preset-text-language-consistency', USER, ctx('First, it supports data sync.', '请介绍功能'))).score, 25);
  });
  it('双语用户只用一种语言不超过 50 分', async () => {
    inject(judgeJson('preset-text-language-consistency', { bilingual_handling: { severity: 'moderate' } }));
    assert.equal((await runTextPreset('preset-text-language-consistency', USER, ctx('请在设置中重置密码。', 'How to reset password？怎么查账单？'))).score, 45);
  });
});

describe('文本简洁性', () => {
  it('直接路径和短事实满分', async () => {
    inject(judgeJson('preset-text-conciseness'));
    assert.equal((await runTextPreset('preset-text-conciseness', USER, ctx('设置 > 系统 > 关闭自动更新。', '怎么关闭自动更新？'))).score, 100);
  });
  it('表达冗余触发上限', async () => {
    inject(judgeJson('preset-text-conciseness', { expression_efficiency: { severity: 'severe' } }));
    assert.equal((await runTextPreset('preset-text-conciseness', USER, ctx('我的名字是叫做 AI 助手，这是一个动听的名字。'))).score, 30);
  });
  it('过度精简导致信息缺失不超过 50 分', async () => {
    inject(judgeJson('preset-text-conciseness', { information_completeness: { severity: 'severe' } }));
    assert.equal((await runTextPreset('preset-text-conciseness', USER, ctx('下载安装包，下一步，完成。', '怎么安装软件？'))).score, 50);
  });
  it('多重套话和无信息内容不超过 20 分', async () => {
    inject(judgeJson('preset-text-conciseness', {
      expression_efficiency: { severity: 'severe' }, cliche_condensation: { severity: 'severe' },
      main_focus: { severity: 'severe' },
    }));
    assert.ok((await runTextPreset('preset-text-conciseness', USER, ctx('您好，很高兴收到您的问题。', '这是什么？'))).score <= 20);
  });
});

