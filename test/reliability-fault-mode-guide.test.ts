import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildFaultModeGuideGroups } from '@/lib/reliability/fault-mode-guide'

describe('buildFaultModeGuideGroups', () => {
  it('按当前数据集使用的故障模式和子模式分组去重', () => {
    const groups = buildFaultModeGuideGroups(
      [
        { values: { fault_injection_type: 'loop', submode: 'literal' } },
        { values: { fault_injection_type: 'loop', submode: 'literal' } },
        { values: { fault_injection_type: 'loop', submode: 'logical' } },
      ],
      [{
        id: 'loop',
        name: '思考死循环',
        description: '思考过程重复或空转。',
        injectionMethodLabel: 'Skill 注入',
        submodes: [
          { id: 'literal', name: '字面重复', description: '持续重复相同思考内容。' },
          { id: 'logical', name: '逻辑循环', description: '反复分析但没有形成行动。' },
        ],
      }],
    )

    assert.equal(groups.length, 1)
    assert.equal(groups[0].submodes.length, 2)
    assert.equal(groups[0].submodes[0].description, '持续重复相同思考内容。')
  })

  it('目录缺失时使用数据项快照，无子模式时显示默认', () => {
    const groups = buildFaultModeGuideGroups(
      [{
        values: {
          fault_injection_type: 'custom',
          fault_label: '自定义故障',
          injection_method_label: '拦截改写',
        },
      }],
      [],
    )

    assert.equal(groups[0].name, '自定义故障')
    assert.equal(groups[0].injectionMethodLabel, '拦截改写')
    assert.equal(groups[0].submodes[0].name, '默认')
  })
})
