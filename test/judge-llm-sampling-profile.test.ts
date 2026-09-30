import assert from 'node:assert/strict';
import test from 'node:test';

type SamplingOptions = {
  temperature: number;
  topP?: number;
  modelKwargs: Record<string, unknown>;
};

type BuildSamplingOptions = (
  modelId: string,
  samplingProfile?: 'canonical-trajectory',
) => SamplingOptions;

test('canonical trajectory disables MiMo 2.5 thinking and omits topP', async () => {
  const judgeLlm = await import('@/lib/engine/experiment/judge-llm') as unknown as {
    buildDirectJudgeSamplingOptions?: BuildSamplingOptions;
  };
  const buildOptions = judgeLlm.buildDirectJudgeSamplingOptions;
  assert.ok(buildOptions, 'missing direct Judge sampling-options builder');

  for (const modelId of ['mimo-v2.5-pro', 'mimo-v2.5']) {
    assert.deepEqual(buildOptions(modelId, 'canonical-trajectory'), {
      temperature: 0,
      modelKwargs: {
        seed: 42,
        thinking: { type: 'disabled' },
      },
    });
  }
});

test('non-MiMo and unprofiled requests retain the existing direct Judge sampling options', async () => {
  const judgeLlm = await import('@/lib/engine/experiment/judge-llm') as unknown as {
    buildDirectJudgeSamplingOptions?: BuildSamplingOptions;
  };
  const buildOptions = judgeLlm.buildDirectJudgeSamplingOptions;
  assert.ok(buildOptions, 'missing direct Judge sampling-options builder');

  for (const [modelId, profile] of [
    ['deepseek-v4-flash', 'canonical-trajectory'],
    ['mimo-v2.5-pro', undefined],
    ['mimo-v2.5', undefined],
  ] as const) {
    assert.deepEqual(buildOptions(modelId, profile), {
      temperature: 0,
      topP: 1,
      modelKwargs: { seed: 42 },
    });
  }
});
