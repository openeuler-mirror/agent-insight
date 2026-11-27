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
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider } from '@/lib/client/locale-context'
import { RasReliabilityDetails } from '@/components/observe/RasReliabilityDetails'
import { buildRasIngestRecord, type RasEventRow } from '@/lib/ingest/ras/normalize'
import { buildRasTraceMarkers } from '@/lib/ingest/ras/trace-markers'
import { buildRasTaskSummaries } from '@/lib/ingest/ras/store'

/** Exercise the production ingest and projection with both stages of one abort. */
function signalRows(failed = false): RasEventRow[] {
  const anchor = { message_id: 'msg_loop', part_id: 'prt_loop', channel: 'llm_output' }
  const events = [
    { type: 'anomaly', anomalyKind: 'llm_thinking_loop', payload: { trace_anchor: anchor, actions: [{ type: 'abort_stream' }] } },
    { type: 'action_result', payload: { action: 'abort_stream', phase: 'terminating', ok: true, trace_anchor: anchor } },
    ...(failed ? [{ type: 'action_result', payload: { action: 'abort_stream', phase: 'failed', ok: false, error: 'SDK_ABORT_ERROR', trace_anchor: anchor } }] : []),
  ]
  return events.map((event, index) => {
    const record = buildRasIngestRecord({ ...event, taskId: 'ses_signals', actionTypes: 'abort_stream',
      deliveryId: `signal-${index}`, ts: `2026-11-05T12:00:0${index}.000Z` })
    return { ...record, id: `event-${index}`, deliveryId: `signal-${index}`, ts: record.ts.toISOString() }
  })
}

/** Render the actual details component with its normal Chinese locale provider. */
function renderRows(rows: RasEventRow[]): string {
  const globalWithReact = globalThis as typeof globalThis & { React?: typeof React }
  const previous = globalWithReact.React
  globalWithReact.React = React
  try {
    return renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(RasReliabilityDetails, { markers: buildRasTraceMarkers(rows, 'zh') })))
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalWithReact, 'React')
    else globalWithReact.React = previous
  }
}

test('terminating reaches the frontend without claiming execution or recovery success', () => {
  const rows = signalRows()
  const markers = buildRasTraceMarkers(rows, 'zh')
  assert.equal(markers[0].actionResults[0].phase, 'terminating')
  const html = renderRows(rows)
  assert.match(html, /终止退出/)
  assert.doesNotMatch(html, /执行成功|退出失败/)
  assert.equal(buildRasTaskSummaries(rows).ses_signals.recoveryOutcome, 'unknown')
})

test('failed abort keeps both frontend signals in time order, including reverse-ordered API rows', () => {
  const rows = signalRows(true).reverse()
  const markers = buildRasTraceMarkers(rows, 'zh')
  assert.deepEqual(markers[0].actionResults.map(result => result.phase), ['terminating', 'failed'])
  const html = renderRows(rows)
  assert.match(html, /终止退出/)
  assert.match(html, /退出失败/)
  assert.match(html, /SDK_ABORT_ERROR/)
  assert.ok(html.indexOf('终止退出') < html.indexOf('退出失败'))
  assert.doesNotMatch(html, /执行成功/)
  assert.equal(buildRasTaskSummaries(rows).ses_signals.recoveryOutcome, 'failed')
})

test('a notice success does not turn a pending termination into recovery success', () => {
  const rows = signalRows()
  rows.push({ ...rows[1], id: 'notice', deliveryId: 'notice', actionTypes: 'emit_notice',
    payloadJson: JSON.stringify({ action: 'emit_notice', ok: true }) })
  assert.equal(buildRasTaskSummaries(rows).ses_signals.recoveryOutcome, 'unknown')
})

test('a terminating signal persisted before the anomaly remains visible under its anchor', () => {
  const rows = signalRows(true)
  rows[1].ts = '2026-11-05T11:59:59.000Z'
  const html = renderRows(rows.reverse())
  assert.match(html, /终止退出/)
  assert.match(html, /退出失败/)
})
