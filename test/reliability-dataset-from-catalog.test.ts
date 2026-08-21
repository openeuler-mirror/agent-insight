import assert from 'node:assert/strict'
import test from 'node:test'

import { composeFaultPrompt } from '@/lib/fault-injection/compose-prompt'
import { expandFaultRows } from '@/lib/fault-injection/expand-fault-rows'
import { normalizeFault } from '@/lib/fault-injection/types'
import { buildCasesFromCatalog } from '@/server/builtin-example/ensure-reliability-dataset'

test('composeFaultPrompt is the SoT for reliability case inputs', () => {
  const withSub = composeFaultPrompt({
    skillName: 'thinking-dead-loop',
    basePrompt: '',
    submode: { id: '2', name: '逻辑死循环' },
  })
  assert.equal(withSub, '使用 thinking-dead-loop 技能，执行逻辑死循环。')

  const plain = composeFaultPrompt({
    skillName: 'analysis-paralysis',
    basePrompt: '',
  })
  assert.equal(plain, '使用 analysis-paralysis 技能。')
})

test('expandFaultRows splits multi-submode faults; keeps single/empty as one row', () => {
  const multi = normalizeFault({
    id: 'thinking-dead-loop',
    skillName: 'thinking-dead-loop',
    submodes: [
      { id: '1', name: '字面重复死循环' },
      { id: '2', name: '逻辑死循环' },
      { id: '3', name: '计划-执行死循环' },
    ],
  })
  const single = normalizeFault({
    id: 'analysis-paralysis',
    skillName: 'analysis-paralysis',
    submodes: [{ id: '1', name: '分析瘫痪长文注入' }],
  })
  const none = normalizeFault({
    id: 'tool-selection-error',
    skillName: 'ras-tool-selection-error',
    submodes: [],
  })
  const rows = expandFaultRows([multi, single, none])
  assert.equal(rows.length, 5)
  assert.deepEqual(
    rows.map((r) => r.key),
    [
      'thinking-dead-loop::1',
      'thinking-dead-loop::2',
      'thinking-dead-loop::3',
      'analysis-paralysis',
      'tool-selection-error',
    ],
  )
})

test('buildCasesFromCatalog emits one case per expanded row with composeFaultPrompt input', () => {
  const faults = [
    normalizeFault({
      id: 'thinking-dead-loop',
      skillName: 'thinking-dead-loop',
      labelZh: '思考死循环',
      submodes: [
        { id: '1', name: '字面重复死循环' },
        { id: '2', name: '逻辑死循环' },
      ],
    }),
    normalizeFault({
      id: 'tool-selection-error',
      skillName: 'ras-tool-selection-error',
      labelZh: '工具选择错误',
      submodes: [],
    }),
  ]
  const cases = buildCasesFromCatalog(faults)
  assert.equal(cases.length, 3)
  assert.equal(cases[0].values?.submode, '1')
  assert.equal(cases[0].input, '使用 thinking-dead-loop 技能，执行字面重复死循环。')
  assert.equal(cases[1].values?.submode, '2')
  assert.equal(cases[1].input, '使用 thinking-dead-loop 技能，执行逻辑死循环。')
  assert.equal(cases[2].values?.fault_injection_type, 'tool-selection-error')
  assert.equal(cases[2].values?.submode, undefined)
  assert.equal(cases[2].input, '使用 ras-tool-selection-error 技能。')
})

test('composeFaultPrompt uses taskPrompt for hidden faults instead of skill name', () => {
  const hidden = composeFaultPrompt({
    skillName: 'ras-skill-selection-conflict',
    basePrompt: '',
    submode: { id: '1', name: '代码审查语义诱馅' },
    hidden: true,
    taskPrompt: 'Review the code quality of target.py.',
  })
  assert.equal(hidden, 'Review the code quality of target.py.')
  assert.ok(!hidden.includes('ras-skill-selection-conflict'))

  // Hidden without taskPrompt falls back to submode name
  const noTask = composeFaultPrompt({
    skillName: 'ras-skill-selection-conflict',
    basePrompt: '',
    submode: { id: '1', name: 'fallback' },
    hidden: true,
  })
  assert.equal(noTask, 'fallback')

  // Non-hidden fault still uses skill template
  const normal = composeFaultPrompt({
    skillName: 'thinking-dead-loop',
    basePrompt: '',
    submode: { id: '2', name: '逻辑死循环' },
  })
  assert.ok(normal.includes('thinking-dead-loop'))
  assert.ok(normal.includes('执行'))
})
