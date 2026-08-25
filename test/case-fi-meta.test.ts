/**
 * ExperimentCase FI 元数据独立列 + evaluatorContext 污染兼容。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractLegacyFiFromEvaluatorContextJson,
  parseExperimentCaseEvaluatorContext,
  resolveCaseFaultInjectionType,
} from '@/lib/engine/experiment/case-fi-meta'
import {
  normalizeEvaluatorCaseContext,
  parseStoredEvaluatorCaseContext,
} from '@/lib/evaluators/evaluator-case-context'

test('parseStored: V1 context ok; FI-only JSON fails schemaVersion', () => {
  const ok = normalizeEvaluatorCaseContext({
    schemaVersion: 1,
    availableTools: [],
  })
  assert.equal(ok?.schemaVersion, 1)

  const polluted = parseStoredEvaluatorCaseContext(
    JSON.stringify({ fault_injection_type: 'analysis-paralysis', fiRunId: 'r1' }),
  )
  assert.equal(polluted.context, null)
  assert.match(String(polluted.error), /schemaVersion/)
})

test('parseExperimentCaseEvaluatorContext: FI-only pollution → no fake error', () => {
  const result = parseExperimentCaseEvaluatorContext(
    JSON.stringify({
      fault_injection_type: 'analysis-paralysis',
      fiRunId: 'run-1',
      fiTaskId: 'task-1',
      values: { fault_injection_type: 'analysis-paralysis' },
    }),
  )
  assert.equal(result.context, null)
  assert.equal(result.error, null)
})

test('parseExperimentCaseEvaluatorContext: V1 + extra FI keys still parses', () => {
  const result = parseExperimentCaseEvaluatorContext(
    JSON.stringify({
      schemaVersion: 1,
      availableTools: [{ name: 'search' }],
      fault_injection_type: 'x',
      fiRunId: 'ignored-by-normalize',
    }),
  )
  assert.deepEqual(result.context, {
    schemaVersion: 1,
    availableTools: [{ name: 'search' }],
  })
  assert.equal(result.error, null)
})

test('resolveCaseFaultInjectionType: column wins over legacy JSON', () => {
  assert.equal(
    resolveCaseFaultInjectionType({
      faultInjectionType: 'col-fault',
      evaluatorContextJson: JSON.stringify({ fault_injection_type: 'legacy-fault' }),
    }),
    'col-fault',
  )
  assert.equal(
    resolveCaseFaultInjectionType({
      faultInjectionType: null,
      evaluatorContextJson: JSON.stringify({
        values: { fault_injection_type: 'from-values' },
      }),
    }),
    'from-values',
  )
})

test('extractLegacyFiFromEvaluatorContextJson marks FI-only pollution', () => {
  const legacy = extractLegacyFiFromEvaluatorContextJson(
    JSON.stringify({ fault_injection_type: 'a', fiTaskId: 't', fiRunId: 'r' }),
  )
  assert.equal(legacy.isFiOnlyPollution, true)
  assert.equal(legacy.faultInjectionType, 'a')
  assert.equal(legacy.fiTaskId, 't')
  assert.equal(legacy.fiRunId, 'r')
})
