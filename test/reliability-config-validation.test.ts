import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

import {
  buildBuiltinConfigSchema,
  validateConfigValues,
} from '@/lib/reliability/client-config-model'

const require_ = createRequire(import.meta.url)
const schema = buildBuiltinConfigSchema('opencode')

const LOOP_THRESHOLD = 'detectors.llm_thinking_loop.loop_repeat_threshold'
const DETECTION_START = 'detectors.llm_thinking_loop.detection_start_chars'
const WINDOW_MAX = 'detectors.llm_thinking_loop.window_max_chars'
const SIM_THRESHOLD = 'detectors.llm_thinking_loop.similar_clause_sim_threshold'

test('rejects values outside the schema range', () => {
  // catalog/yaml：similar_clause_sim_threshold ∈ [0,1]；越界值不得写入快照下发。
  const tooBig = validateConfigValues(schema, { [SIM_THRESHOLD]: 1.5 })
  assert.equal(tooBig.length, 1)
  assert.match(tooBig[0].message, /不能大于 1/)

  const tooSmall = validateConfigValues(schema, { [DETECTION_START]: 0 })
  assert.equal(tooSmall.length, 1)
  assert.match(tooSmall[0].message, /不能小于 1/)
})

test('accepts boundary values', () => {
  assert.deepEqual(
    validateConfigValues(schema, {
      [LOOP_THRESHOLD]: 2,
      [DETECTION_START]: 1,
      [WINDOW_MAX]: 100,
      [SIM_THRESHOLD]: 0,
    }),
    [],
  )
  assert.deepEqual(validateConfigValues(schema, { [SIM_THRESHOLD]: 1 }), [])
})

test('rejects non-numeric and non-integer input', () => {
  assert.match(validateConfigValues(schema, { [LOOP_THRESHOLD]: 'abc' })[0].message, /必须是数字/)
  assert.match(validateConfigValues(schema, { [LOOP_THRESHOLD]: 2.5 })[0].message, /必须是整数/)
  // NaN 曾能进状态，JSON.stringify 后变 null 污染下发配置。
  assert.match(validateConfigValues(schema, { [LOOP_THRESHOLD]: Number.NaN })[0].message, /必须是数字/)
})

test('empty means empty, not zero', () => {
  // Number('') === 0 曾让「清空输入框」变成写入 0，而 0 往往低于 min。
  const errs = validateConfigValues(schema, { [LOOP_THRESHOLD]: '' })
  assert.equal(errs.length, 1)
  assert.match(errs[0].message, /不能为空/)
})

test('leading zeros parse to the intended number', () => {
  // 前导零是编辑中间态，值本身合法就该放行。
  assert.deepEqual(validateConfigValues(schema, { [LOOP_THRESHOLD]: '03' }), [])
  assert.match(
    validateConfigValues(schema, { [SIM_THRESHOLD]: '0333' })[0].message,
    /不能大于 1/,
  )
})

test('only submitted keys are checked', () => {
  // 保存提交的是 overrideDiff；未覆盖字段继承内置默认值，不该被判成缺失。
  assert.deepEqual(validateConfigValues(schema, {}), [])
})

test('unknown keys are ignored rather than rejected', () => {
  // 平台升级删掉的旧字段由迁移器处理，这里报错会让用户卡在无法保存。
  assert.deepEqual(validateConfigValues(schema, { 'gone.field': 1 }), [])
})

test('number input keeps a string draft so React cannot strand a stale display', () => {
  // type=number 的受控输入用宽松比较：回写数字时 "03333" == 3333 为真，
  // React 跳过 DOM 更新，界面停在带前导零的旧文本，与状态不一致。
  const src = require_('node:fs').readFileSync(
    require_('node:path').join(__dirname, '..', 'src', 'app', '(main)', 'accessconfig', 'client', 'page.tsx'),
    'utf8',
  ) as string
  assert.doesNotMatch(src, /value=\{Number\(value \?\? 0\)\}/, '不得把受控值回写成数字')
  assert.match(src, /String\(value\)/, '受控值应保持字符串')
  assert.match(src, /hasFieldError/, '有字段错误时应禁用保存')
})
