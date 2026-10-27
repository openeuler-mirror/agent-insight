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
  faultModeSummary,
  faultSubmodeDescription,
} from '@/lib/reliability/fault-mode-copy'

describe('reliability fault mode copy', () => {
  it('使用独立于 Skill 定义的逻辑说明', () => {
    assert.equal(
      faultModeSummary('thinking-dead-loop'),
      'Agent 的思考过程重复或空转，任务持续没有有效进展。',
    )
    assert.equal(
      faultSubmodeDescription('thinking-dead-loop', '1'),
      'Agent 持续重复相同思考内容，无法推进任务。',
    )
    assert.doesNotMatch(faultSubmodeDescription('thinking-dead-loop', '1'), /让我协助/)
  })

  it('未配置展示文案时保留目录原值', () => {
    assert.equal(faultModeSummary('custom-fault', '原始摘要'), '原始摘要')
    assert.equal(
      faultSubmodeDescription('custom-fault', 'custom-submode', '原始说明'),
      '原始说明',
    )
  })
})
