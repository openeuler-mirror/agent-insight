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
  buildFiPipelineMarkers,
  buildFiTraceMarkers,
} from '../src/lib/fault-injection/trace-markers'
import { buildMarkerPipeline } from '../src/lib/fault-injection/marker-pipeline'
import { listFaultsViaPython } from '../src/lib/fault-injection/engine'
import {
  FI_WORKSPACE_DEFAULT,
  normalizeFiWorkspaceInput,
  resolveFiWorkspaceOnClient,
} from '../src/lib/fault-injection/workspace'
import { composeFaultPrompt, findSubmode } from '../src/lib/fault-injection/compose-prompt'
import { normalizeFault } from '../src/lib/fault-injection/types'

describe('fault-injection markers', () => {
  it('maps FI markers with anchors and payload', () => {
    const markers = buildFiTraceMarkers([
      {
        id: 'm1',
        kind: 'fault_activation',
        label: 'Fault activation requested',
        timestamp: 1700000000000,
        payload: {
          faultSkill: 'thinking-dead-loop',
          instruction: 'do case 2',
          callID: 'call-1',
          trace_anchor: { message_id: 'msg-1' },
        },
      },
    ])
    assert.equal(markers.length, 1)
    assert.equal(markers[0].source, 'fi')
    assert.equal(markers[0].messageId, 'msg-1')
    assert.equal(markers[0].callId, 'call-1')
    assert.equal(markers[0].payload?.faultSkill, 'thinking-dead-loop')
  })

  it('builds four-node pipeline from activation markers', () => {
    const pipeline = buildFiPipelineMarkers([
      { id: '1', kind: 'fault_activation', label: 'Fault activation requested', payload: {} },
      { id: '2', kind: 'fault_activation', label: 'Fault activation started', payload: {} },
      { id: '3', kind: 'fault_activation', label: 'Fault activation completed', payload: {} },
      {
        id: '4',
        kind: 'evaluation',
        label: 'Evaluation skipped',
        payload: { reason: 'judge_skipped' },
      },
    ])
    const steps = buildMarkerPipeline(pipeline)
    assert.equal(steps.length, 4)
    assert.equal(steps.filter((s) => s.done).length, 4)
    assert.equal(steps[3].skipped, true)
  })

  it('new injection pipelines have no pending Judge stage', () => {
    const steps = buildMarkerPipeline(buildFiPipelineMarkers([
      { kind: 'fault_activation', label: 'Fault activation requested' },
      { kind: 'fault_activation', label: 'Fault activation started' },
      { kind: 'fault_activation', label: 'Fault activation completed' },
    ]))
    assert.deepEqual(steps.map(step => step.key), ['fault_requested', 'fault_started', 'fault_completed'])
    assert.equal(steps.every(step => step.done), true)
  })
})

describe('fault-injection catalog submodes', () => {
  it('resolves thinking-dead-loop submode ids 1/2/3', async () => {
    const rows = (await listFaultsViaPython()) as Array<Record<string, unknown>>
    const raw = rows.find((row) => String(row.name || row.id) === 'thinking-dead-loop')
    assert.ok(raw, 'thinking-dead-loop missing from catalog')
    const fault = normalizeFault(raw!)
    assert.equal(fault.submodes?.length, 3)
    assert.deepEqual(
      fault.submodes?.map((s) => s.id),
      ['1', '2', '3'],
    )
    assert.ok(fault.submodes?.some((s) => s.name.includes('逻辑')))
    assert.ok(fault.labelZh)
    assert.ok(fault.injectionMethodLabel)
  })

  it('resolves tool_repeat_dead_loop submodes 1..4', async () => {
    const rows = (await listFaultsViaPython()) as Array<Record<string, unknown>>
    const raw = rows.find((row) => String(row.name || row.id) === 'tool_repeat_dead_loop')
    assert.ok(raw)
    const fault = normalizeFault(raw!)
    assert.equal(fault.submodes?.length, 4)
    assert.deepEqual(
      fault.submodes?.map((s) => s.id),
      ['1', '2', '3', '4'],
    )
  })
})

describe('fault-injection workspace contract', () => {
  it('normalizes empty and ~ to logical default', () => {
    assert.equal(normalizeFiWorkspaceInput(''), FI_WORKSPACE_DEFAULT)
    assert.equal(normalizeFiWorkspaceInput('~'), FI_WORKSPACE_DEFAULT)
    assert.equal(normalizeFiWorkspaceInput('~/work'), FI_WORKSPACE_DEFAULT)
    assert.equal(normalizeFiWorkspaceInput('/tmp/ws'), '/tmp/ws')
    assert.equal(normalizeFiWorkspaceInput('rel/path'), 'rel/path')
  })

  it('resolves logical workspace on client', () => {
    const base = '/home/u/.agent-insight/fault-injection/workspaces'
    const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')
    const resolve = (_b: string, rel: string) => `/resolved/${rel}`
    assert.equal(resolveFiWorkspaceOnClient(FI_WORKSPACE_DEFAULT, base, join, resolve), base)
    assert.equal(resolveFiWorkspaceOnClient('sub', base, join, resolve), '/resolved/sub')
    assert.equal(resolveFiWorkspaceOnClient('/abs', base, join, resolve), '/abs')
  })
})

describe('fault-injection compose prompt', () => {
  it('builds skill activation for submode', () => {
    const prompt = composeFaultPrompt({
      skillName: 'thinking-dead-loop',
      basePrompt: '',
      submode: { id: '2', name: '逻辑死循环' },
    })
    assert.equal(prompt, '使用 thinking-dead-loop 技能，执行逻辑死循环。')
  })

  it('appends base prompt when provided', () => {
    const prompt = composeFaultPrompt({
      skillName: 'thinking-dead-loop',
      basePrompt: '额外说明',
      submode: { id: '1', name: '字面重复死循环' },
    })
    assert.match(prompt, /^使用 thinking-dead-loop 技能，执行字面重复死循环。/)
    assert.match(prompt, /额外说明/)
  })

  it('finds submode by id', () => {
    const found = findSubmode(
      [
        { id: '1', name: 'Alpha' },
        { id: '2', name: 'Beta' },
      ],
      '2',
    )
    assert.equal(found?.name, 'Beta')
  })
})
