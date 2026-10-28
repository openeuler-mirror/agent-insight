import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/** Explicit CLI exit must preserve the final message and its idle event. */
for (const terminal of [
  { type: 'session.idle', properties: { sessionID: 'ses_durable' } },
  { type: 'session.status', properties: { sessionID: 'ses_durable', status: { type: 'idle' } } },
]) {
  test('completion spool survives immediate CLI exit: ' + terminal.type, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-completion-'))
    const pluginUrl = pathToFileURL(path.resolve('scripts/opencode_plugin_otel.ts')).href
    const source = [
      'const mod = await import(' + JSON.stringify(pluginUrl) + ')',
      'const initialize = mod.default?.default ?? mod.default',
      'const hooks = await initialize()',
      'await hooks.event({ event: { type: "message.updated", properties: { info: { id: "msg_final", sessionID: "ses_durable", role: "assistant", time: { created: 1, completed: 2 } } } } })',
      'void hooks.event({ event: ' + JSON.stringify(terminal) + ' })',
      'process.exit(0)',
    ].join('\n')
    try {
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, AGENT_INSIGHT_HOME: root, AGENT_INSIGHT_HOST: '',
          AGENT_INSIGHT_API_KEY: '', AGENT_INSIGHT_OPENCODE_OTEL_ENABLE: 'true',
          AGENT_INSIGHT_OPENCODE_SPOOL_DIR: path.join(root, 'spool') },
      })
      assert.equal(child.status, 0, child.stderr)
      const pluginLog = fs.readFileSync(path.join(root, 'logs/opencode_plugin.log'), 'utf8')
      assert.ok(pluginLog.includes('reason=event:' + terminal.type),
        'terminal upload must be scheduled before a host exits without awaiting the hook: ' + pluginLog)

      const files = fs.readdirSync(path.join(root, 'spool'), { recursive: true })
        .map(String).filter(file => file.endsWith('.jsonl'))
      const events = files.flatMap(file => fs.readFileSync(path.join(root, 'spool', file), 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line)))
      const kinds = events.filter(event => event.kind === 'event').map(event => event.payload.type)
      assert.deepEqual(kinds, ['message.updated', terminal.type])
      assert.equal(events.find(event => event.payload?.type === 'message.updated').payload.event.properties.info.time.completed, 2)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
}
