import assert from 'node:assert/strict';
import test from 'node:test';

test('内置 OpenCode 子进程关闭 TLS 校验且不修改父进程环境', async () => {
  const tlsPolicy = await import('@/lib/engine/skill-generation/opencode-agent-cli/opencode-spawn-policy')
    .catch(() => ({} as Record<string, unknown>));
  const buildEnv = tlsPolicy.buildOpencodeSpawnEnv as
    | ((base: NodeJS.ProcessEnv, overrides?: Record<string, string>) => NodeJS.ProcessEnv)
    | undefined;
  assert.equal(typeof buildEnv, 'function', '缺少 OpenCode spawn 环境策略');

  const parentEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: '/usr/bin',
    NODE_TLS_REJECT_UNAUTHORIZED: '1',
  };
  const childEnv = buildEnv!(parentEnv, { OPENCODE_PORT: '4096' });

  assert.equal(childEnv.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  assert.equal(childEnv.OPENCODE_PORT, '4096');
  assert.equal(parentEnv.NODE_TLS_REJECT_UNAUTHORIZED, '1');
});

test('A/B 新一轮开始时只保留本次 case，并立即初始化为排队执行', async () => {
  const abStartState = await import('@/lib/skill-analysis/ab-run-start-state')
    .catch(() => ({} as Record<string, unknown>));
  const buildStates = abStartState.buildOptimisticAbRunStates as
    | ((caseIds: string[], repeatRounds: number) => Record<string, {
        a: { status: string; runCount: number; runs: Array<{ status: string; runIndex: number }> };
        b: { status: string; runCount: number; runs: Array<{ status: string; runIndex: number }> };
      }>)
    | undefined;
  assert.equal(typeof buildStates, 'function', '缺少 A/B 启动态构造器');

  const states = buildStates!(['case-new'], 2);
  assert.deepEqual(Object.keys(states), ['case-new']);
  assert.equal(states['case-new'].a.status, 'running');
  assert.equal(states['case-new'].b.status, 'running');
  assert.equal(states['case-new'].a.runCount, 2);
  assert.deepEqual(
    states['case-new'].a.runs.map(run => [run.runIndex, run.status]),
    [[1, 'pending'], [2, 'pending']],
  );
});

test('A/B 失败评估器重试时写 pending，确保后端会选中', async () => {
  const abStartState = await import('@/lib/skill-analysis/ab-run-start-state');
  const retryStatus = (abStartState as Record<string, unknown>).AB_EVALUATOR_RETRY_DISPATCH_STATUS;
  assert.equal(retryStatus, 'pending');
});
