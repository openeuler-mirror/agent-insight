import assert from 'node:assert/strict'
import test from 'node:test'

import { coerceDatasetKind, defaultDatasetSchemaFields, defaultFieldsForKind } from '@/lib/agent-dataset-model'
import { normalizeDatasetKind, validateCasesForKind, type DatasetCase } from '@/server/agent_datasets_storage'

test('DatasetKind reliability is first-class', () => {
  assert.equal(coerceDatasetKind('reliability'), 'reliability')
  assert.equal(normalizeDatasetKind('reliability'), 'reliability')
  assert.equal(normalizeDatasetKind('other'), 'ideal_output')

  const fields = defaultDatasetSchemaFields('reliability')
  assert.ok(fields.some((f) => f.key === 'fault_injection_type' && f.system))
  assert.ok(fields.some((f) => f.key === 'input' && f.system))

  const defs = defaultFieldsForKind('reliability')
  assert.equal(defs.find((f) => f.key === 'fault_injection_type')?.required, '是')
})

test('reliability cases require registered fault_injection_type', () => {
  const cases: DatasetCase[] = [
    {
      id: 'c1',
      input: '分析日志',
      expectedOutput: '',
      evaluationFocus: '',
      tags: [],
      trajectory: '',
      values: {},
    },
    {
      id: 'c2',
      input: '分析日志',
      expectedOutput: '',
      evaluationFocus: '',
      tags: [],
      trajectory: '',
      values: { fault_injection_type: 'model_timeout' },
    },
    {
      id: 'c3',
      input: '分析日志',
      expectedOutput: '',
      evaluationFocus: '',
      tags: [],
      trajectory: '',
      values: { fault_injection_type: 'not_in_registry' },
    },
  ]

  const errors = validateCasesForKind(cases, 'reliability', {
    allowedFaultModeIds: new Set(['model_timeout']),
  })
  assert.equal(errors.length, 2)
  assert.equal(errors[0].caseId, 'c1')
  assert.equal(errors[0].field, 'fault_injection_type')
  assert.equal(errors[1].caseId, 'c3')
  assert.equal(errors[1].code, 'unknown_fault_mode')

  assert.deepEqual(validateCasesForKind(cases, 'ideal_output'), [])
})
