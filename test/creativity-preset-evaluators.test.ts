import assert from 'node:assert';
import { describe, it, after } from 'node:test';
import { setJudgeLlmCallerForTest } from '../src/lib/engine/experiment/judge-llm';
import { runCreativityPreset } from '../src/lib/engine/experiment/creativity-preset-evaluators';
import type { FaithfulPresetContext } from '../src/lib/engine/experiment/faithful-preset-evaluators';

const USER = 'test-user';
function ctx(a: string) { return { caseInput: '', actualOutput: a, referenceOutput: null, traceSummaryText: null, interactions: [], taskId: null, executionId: null, user: null, execution: null } as FaithfulPresetContext; }
function inject(t: string) { setJudgeLlmCallerForTest(async () => t); }
after(() => setJudgeLlmCallerForTest(null));

describe('创造性评估器 全链路', () => {
  const all3 = () => ({ novelty: { rating: 3, comment: '好' }, perspective_uniqueness: { rating: 3, comment: '好' }, non_template_expression: { rating: 3, comment: '好' }, idea_diversity: { rating: 3, comment: '好' }, rhetoric_quality: { rating: 3, comment: '好' } });
  const all2 = () => ({ novelty: { rating: 2, comment: '中' }, perspective_uniqueness: { rating: 2, comment: '中' }, non_template_expression: { rating: 2, comment: '中' }, idea_diversity: { rating: 2, comment: '中' }, rhetoric_quality: { rating: 2, comment: '中' } });
  const all1 = () => ({ novelty: { rating: 1, comment: '差' }, perspective_uniqueness: { rating: 1, comment: '差' }, non_template_expression: { rating: 1, comment: '差' }, idea_diversity: { rating: 1, comment: '差' }, rhetoric_quality: { rating: 1, comment: '差' } });

  it('全1 → 0', async () => {
    inject(JSON.stringify({ dimensions: all1(), overall_reason: '模板化。' }));
    assert.strictEqual((await runCreativityPreset('preset-creativity', USER, ctx('x'))).score, 0);
  });
  it('全2 → 50', async () => {
    inject(JSON.stringify({ dimensions: all2(), overall_reason: '中等。' }));
    assert.strictEqual((await runCreativityPreset('preset-creativity', USER, ctx('x'))).score, 50);
  });
  it('全3 → 100', async () => {
    inject(JSON.stringify({ dimensions: all3(), overall_reason: '优秀。' }));
    assert.strictEqual((await runCreativityPreset('preset-creativity', USER, ctx('x'))).score, 100);
  });
  it('[3,2,1,1,1] → 30', async () => {
    inject(JSON.stringify({ dimensions: { novelty: { rating: 3, comment: '好' }, perspective_uniqueness: { rating: 2, comment: '中' }, non_template_expression: { rating: 1, comment: '差' }, idea_diversity: { rating: 1, comment: '差' }, rhetoric_quality: { rating: 1, comment: '差' } }, overall_reason: '混合。' }));
    assert.strictEqual((await runCreativityPreset('preset-creativity', USER, ctx('x'))).score, 30);
  });
  it('[3,3,1,2,2] → 60', async () => {
    inject(JSON.stringify({ dimensions: { novelty: { rating: 3, comment: '好' }, perspective_uniqueness: { rating: 3, comment: '好' }, non_template_expression: { rating: 1, comment: '差' }, idea_diversity: { rating: 2, comment: '中' }, rhetoric_quality: { rating: 2, comment: '中' } }, overall_reason: '混合。' }));
    assert.strictEqual((await runCreativityPreset('preset-creativity', USER, ctx('x'))).score, 60);
  });
  it('string rating → parse', async () => {
    inject(JSON.stringify({ dimensions: { novelty: { rating: '3', comment: '好' }, perspective_uniqueness: { rating: 3, comment: '好' }, non_template_expression: { rating: 3, comment: '好' }, idea_diversity: { rating: 3, comment: '好' }, rhetoric_quality: { rating: 3, comment: '好' } }, overall_reason: 'x' }));
    assert.strictEqual((await runCreativityPreset('preset-creativity', USER, ctx('x'))).score, 100);
  });
  it('缺维度 → throw', async () => {
    inject(JSON.stringify({ dimensions: { novelty: { rating: 2, comment: 'x' } }, overall_reason: 'x' }));
    await assert.rejects(() => runCreativityPreset('preset-creativity', USER, ctx('x')), (e: Error) => e.name === 'ContentPresetParseError');
  });
  it('rating>3 → throw', async () => {
    const d = all3(); d.novelty.rating = 9;
    inject(JSON.stringify({ dimensions: d, overall_reason: 'x' }));
    await assert.rejects(() => runCreativityPreset('preset-creativity', USER, ctx('x')), (e: Error) => e.name === 'ContentPresetParseError');
  });
  it('rating<1 → throw', async () => {
    const d = all3(); d.novelty.rating = 0;
    inject(JSON.stringify({ dimensions: d, overall_reason: 'x' }));
    await assert.rejects(() => runCreativityPreset('preset-creativity', USER, ctx('x')), (e: Error) => e.name === 'ContentPresetParseError');
  });
  it('comment 空 → throw', async () => {
    const d = all3(); d.novelty.comment = '';
    inject(JSON.stringify({ dimensions: d, overall_reason: 'x' }));
    await assert.rejects(() => runCreativityPreset('preset-creativity', USER, ctx('x')), (e: Error) => e.name === 'ContentPresetParseError');
  });
  it('overall_reason 写入 evidence', async () => {
    inject(JSON.stringify({ dimensions: all3(), overall_reason: '高度创造性。' }));
    const r = await runCreativityPreset('preset-creativity', USER, ctx('x'));
    assert.ok(((r.evidence as { md?: string } | undefined)?.md ?? '').includes('高度创造性'));
  });
});

// 破坏验证：取消注释应全红
// import { CREATIVITY_DIMS as _d } from '../src/lib/engine/experiment/creativity-preset-evaluators';
// if (_d.length) Math.round = () => 50;
