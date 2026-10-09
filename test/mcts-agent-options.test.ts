import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MctsOptionsFields } from '../src/components/eval/MctsOptionsFields'
import { MCTS_DEFAULT_OPTIONS, MCTS_QUICK_OPTIONS, mctsOptionArgs, normalizeAgentOptions } from '../services/executor/src/mcts-options.cjs'
import { mctsOptionsState, mctsOptionsToInputs, summarizeMctsOptions } from '../src/lib/engine/experiment/mcts-options'
import { normalizeBenchmarkAgentOptions } from '../packages/benchmark-protocol/src/contracts'
import { assertBenchmarkExecutionTarget } from '../src/lib/benchmark/execution-targets'

const capability = 'mcts-search-options/v1'

test('MCTS parameter fields render the seven controls, explicit zero and validation feedback', () => {
  const markup = renderToStaticMarkup(createElement(MctsOptionsFields, {
    value: mctsOptionsToInputs({ mcts: MCTS_QUICK_OPTIONS }), error: '参数不合法', onChange: () => {},
  }))
  assert.equal((markup.match(/type="number"/g) || []).length, 7)
  assert.match(markup, /aria-label="Token 熔断阈值"[^>]+value="0"/)
  assert.match(markup, /role="alert">参数不合法/)
  assert.match(markup, /填入联调参数/)
  assert.match(markup, /恢复默认/)
})

test('MCTS form uses declared capabilities across runtimes and requires a SWE-bench dataset', () => {
  const inputs = mctsOptionsToInputs({ mcts: MCTS_QUICK_OPTIONS })
  assert.equal(inputs.tokenFuseLimit, '0')
  for (const platform of ['pi-mcts', 'xiao-mcts', 'another-mcts']) {
    const state = mctsOptionsState({ platform, agentOptionCapabilities: [capability] }, inputs, 'pi-mcts', 'swe-bench')
    assert.equal(state.active, true)
    assert.deepEqual(state.agentOptions, { mcts: MCTS_QUICK_OPTIONS })
    assert.equal(state.error, null)
    assert.deepEqual(mctsOptionsState({ platform, agentOptionCapabilities: [capability] }, {}, platform, 'swe-bench').agentOptions,
      { mcts: MCTS_DEFAULT_OPTIONS })
    for (const benchmark of [undefined, '', 'another-benchmark']) {
      assert.deepEqual(mctsOptionsState({ platform, agentOptionCapabilities: [capability] }, inputs, platform, benchmark),
        { active: false, error: null })
    }
  }
  assert.deepEqual(mctsOptionsState({ platform: 'opencode' }, inputs, 'pi-mcts', 'swe-bench'), { active: false, error: null })
  assert.match(mctsOptionsState({ platform: 'pi-mcts' }, inputs, 'pi-mcts', 'swe-bench').error!, /升级客户端/)
  assert.match(mctsOptionsState({ platform: 'pi-mcts', agentOptionCapabilities: [capability] }, { branching: '1.5' }, '', 'swe-bench').error!, /正安全整数/)
  assert.equal(summarizeMctsOptions({ mcts: { tokenFuseLimit: 0 } }), 'Token 熔断阈值：关闭')
})

test('MCTS defaults are visible, frozen in options and required after an input is cleared', () => {
  const inputs = mctsOptionsToInputs(undefined)
  assert.deepEqual(inputs, { maxIters: '5', branching: '3', maxTurnsInit: '160', maxTurnsStep: '80',
    maxTurnsAuthor: '160', maxTurnsAuthorStep: '80', tokenFuseLimit: '30000000' })
  const target = { platform: 'pi-mcts', agentOptionCapabilities: [capability] }
  assert.deepEqual(mctsOptionsState(target, inputs, '', 'swe-bench').agentOptions, { mcts: MCTS_DEFAULT_OPTIONS })
  assert.match(mctsOptionsState(target, { ...inputs, maxIters: '' }, '', 'swe-bench').error!, /不能为空/)
  assert.equal(mctsOptionsToInputs({ mcts: { tokenFuseLimit: 0 } }).tokenFuseLimit, '0')
  assert.equal(mctsOptionsToInputs({ mcts: { tokenFuseLimit: 0 } }).maxIters, '5')
  const markup = renderToStaticMarkup(createElement(MctsOptionsFields, { value: inputs, error: null, onChange: () => {} }))
  assert.doesNotMatch(markup, /沿用 MCTS 配置|placeholder=/)
  assert.match(markup, /value="30000000"/)
  assert.deepEqual(mctsOptionArgs({ mcts: MCTS_DEFAULT_OPTIONS }), ['--max-iters', '5', '--branching', '3',
    '--max-turns-init', '160', '--max-turns-step', '80', '--max-turns-author', '160', '--max-turns-author-step', '80',
    '--token-fuse-limit', '30000000'])
})

test('MCTS options reject unknown fields, unsafe integers and invalid types at the protocol boundary', () => {
  for (const value of [[], 'flags', { other: {} }, { mcts: null }, { mcts: { unknown: 1 } },
    { mcts: { maxIters: 0 } }, { mcts: { branching: -1 } }, { mcts: { maxTurnsInit: 1.5 } },
    { mcts: { maxTurnsStep: '20' } }, { mcts: { tokenFuseLimit: -1 } }, { mcts: { maxIters: Number.MAX_SAFE_INTEGER + 1 } }]) {
    assert.throws(() => normalizeAgentOptions(value))
    assert.throws(() => normalizeBenchmarkAgentOptions(value), { code: 'AGENT_OPTIONS_INVALID' })
  }
  assert.equal(normalizeAgentOptions({ mcts: {} }), undefined)
  assert.deepEqual(mctsOptionArgs({ mcts: { tokenFuseLimit: 0 } }), ['--token-fuse-limit', '0'])
  assert.deepEqual(mctsOptionArgs(undefined), [])
})

test('custom MCTS parameters require a ready capability on the selected platform', () => {
  const manifest = { requiredCapabilities: ['git-workspace/v1', 'git-patch/v1'] }
  for (const platform of ['pi-mcts', 'xiao-mcts']) {
    for (const supported of [false, true]) {
      const client = { clientId: 'fixture', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), unboundAt: null,
        capabilitiesJson: JSON.stringify({ actions: ['RUN_BENCHMARK_CASE'], platforms: [{ id: platform, agents: [platform],
          runBenchmarkCase: { version: 1, returnsTraceId: true, agentOptionCapabilities: supported ? [capability] : [] } }],
        components: { 'git-workspace/v1': true, 'git-patch/v1': true, [`agent-runtime/${platform}/v1`]: true, [capability]: { ready: true } },
        }) }
      const target = { platform, agent: platform, agentOptions: { mcts: { tokenFuseLimit: 0 } } }
      if (supported) assert.deepEqual(assertBenchmarkExecutionTarget(client as never, manifest as never, target).agentOptionCapabilities, [capability])
      else assert.throws(() => assertBenchmarkExecutionTarget(client as never, manifest as never, target), { code: 'CLIENT_UPGRADE_REQUIRED' })
      assert.ok(assertBenchmarkExecutionTarget(client as never, manifest as never, { platform, agent: platform }))
    }
  }
})
