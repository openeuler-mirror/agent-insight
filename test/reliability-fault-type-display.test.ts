/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatReliabilityFaultTypeDisplay,
  formatReliabilityFaultTypeFromCaseValues,
} from '@/lib/reliability/fault-type-display'

describe('formatReliabilityFaultTypeDisplay', () => {
  it('大类 · 小类 · 注入方式', () => {
    assert.equal(
      formatReliabilityFaultTypeDisplay({
        faultLabel: '思考死循环',
        submodeLabel: '相似子句循环',
        injectionMethodLabel: 'Skill 注入',
      }),
      '思考死循环 · 相似子句循环 · Skill 注入',
    )
  })

  it('无小类时省略中间段', () => {
    assert.equal(
      formatReliabilityFaultTypeDisplay({
        faultLabel: '工具重复死循环',
        submodeLabel: '',
        injectionMethodLabel: 'Skill 注入',
      }),
      '工具重复死循环 · Skill 注入',
    )
  })

  it('仅有大类时只显示大类', () => {
    assert.equal(
      formatReliabilityFaultTypeDisplay({ faultLabel: '提前停止', fallbackId: 'ras-early-stop' }),
      '提前停止',
    )
  })

  it('全空时回退 id', () => {
    assert.equal(
      formatReliabilityFaultTypeDisplay({ fallbackId: 'thinking-dead-loop' }),
      'thinking-dead-loop',
    )
  })
})

describe('formatReliabilityFaultTypeFromCaseValues', () => {
  it('优先 case.values，API 名可覆盖大类与注入方式', () => {
    assert.equal(
      formatReliabilityFaultTypeFromCaseValues(
        {
          fault_injection_type: 'thinking-dead-loop',
          fault_label: '思考死循环',
          submode: 'similar_clauses',
          submode_label: '相似子句',
          injection_method_label: 'Skill 注入',
        },
        { apiFaultName: '思考死循环(API)', apiInjectionMethodLabel: 'Skill 注入' },
      ),
      '思考死循环(API) · 相似子句 · Skill 注入',
    )
  })

  it('可用 API 参数解析小类名', () => {
    assert.equal(
      formatReliabilityFaultTypeFromCaseValues(
        { fault_injection_type: 'thinking-dead-loop', submode: 'x' },
        {
          apiFaultName: '思考死循环',
          apiSubmodeLabel: '子类X',
          apiInjectionMethodLabel: 'Skill 注入',
        },
      ),
      '思考死循环 · 子类X · Skill 注入',
    )
  })
})
