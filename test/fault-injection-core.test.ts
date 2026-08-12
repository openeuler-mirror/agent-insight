import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isValidOutcomeContainmentPair,
  parseFaultJudgeResponse,
  skippedJudgeResult,
} from '../src/lib/fault-injection/judge-result'
import {
  buildFiPipelineMarkers,
  buildFiTraceMarkers,
  mergeEvaluationMarkers,
} from '../src/lib/fault-injection/trace-markers'
import { buildMarkerPipeline } from '../src/lib/fault-injection/marker-pipeline'
import { listFaultsViaPython } from '../src/lib/fault-injection/engine'
import {
  FI_WORKSPACE_DEFAULT,
  normalizeFiWorkspaceInput,
  resolveFiWorkspaceOnClient,
} from '../src/lib/fault-injection/workspace'
import { composeFaultPrompt, findSubmode } from '../src/lib/fault-injection/compose-prompt'
import { normalizeFault } from '../src/components/fault-injection/types'

describe('fault-injection judge-result', () => {
  it('accepts valid pairs', () => {
    assert.equal(isValidOutcomeContainmentPair('occurred', 'unresolved'), true)
    assert.equal(isValidOutcomeContainmentPair('not_occurred', 'prevented'), true)
    assert.equal(isValidOutcomeContainmentPair('occurred', 'prevented'), false)
  })

  it('parses judge JSON from noisy text', () => {
    const parsed = parseFaultJudgeResponse(`Here you go:
{"outcome":"occurred","fault_containment_status":"unresolved","reason":"agent followed bad tool output"}
`)
    assert.equal(parsed.outcome, 'occurred')
    assert.equal(parsed.fault_containment_status, 'unresolved')
  })

  it('rejects invalid pairs', () => {
    assert.throws(() =>
      parseFaultJudgeResponse(
        JSON.stringify({
          outcome: 'occurred',
          fault_containment_status: 'prevented',
          reason: 'bad',
        }),
      ),
    )
  })

  it('builds skipped result', () => {
    const skipped = skippedJudgeResult('not activated')
    assert.equal(skipped.outcome, 'not_occurred')
    assert.equal(skipped.fault_containment_status, 'inconclusive')
  })
})

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

  it('merges evaluation markers after judge', () => {
    const merged = mergeEvaluationMarkers(
      [{ id: '1', kind: 'fault_activation', label: 'Fault activation requested' }],
      { skipped: true, reason: 'No active model configured in Insight settings.' },
    )
    assert.equal(merged.length, 2)
    assert.equal((merged[1] as { kind: string }).kind, 'evaluation')
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
