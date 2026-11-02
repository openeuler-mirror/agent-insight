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

const { randomBytes } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

function prepareOpencodeEventChannel(env, major = 1) {
  let config
  try { config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}') }
  catch { throw Object.assign(new Error('OpenCode 进程配置无法解析，无法启用失败监测通道'), { code: 'EVENT_MONITOR_UNAVAILABLE' }) }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw Object.assign(new Error('OpenCode 进程配置必须为对象'), { code: 'EVENT_MONITOR_UNAVAILABLE' })
  }
  const token = randomBytes(24).toString('hex')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-opencode-events-'))
  const eventFile = path.join(directory, 'events.jsonl')
  const plugin = pathToFileURL(path.join(directory, 'plugin.mjs')).href
  try {
    // Older OpenCode loaders treat imported CJS as ESM with no exports.
    const diagnostics = fs.readFileSync(path.join(__dirname, 'agent-run-diagnostics.cjs'), 'utf8')
    if (!diagnostics.includes('module.exports = ')) throw new Error('诊断模块缺少导出')
    fs.writeFileSync(path.join(directory, 'diagnostics.mjs'), diagnostics.replace('module.exports = ', 'export default '))
    const source = fs.readFileSync(path.join(__dirname, major === 2 ? 'opencode-experiment-events-v2.mjs' : 'opencode-experiment-events.mjs'), 'utf8')
    fs.writeFileSync(path.join(directory, 'plugin.mjs'), source.replace('./agent-run-diagnostics.cjs', './diagnostics.mjs'))
    fs.writeFileSync(eventFile, '', { mode: 0o600 })
    fs.writeFileSync(path.join(directory, 'index.js'), `export { default } from ${JSON.stringify(plugin)};\n`)
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return {
    token,
    eventFile,
    cleanup: () => { if (directory) fs.rmSync(directory, { recursive: true, force: true }) },
    env: {
      AGENT_INSIGHT_EVENT_TOKEN: token,
      ...(eventFile ? { AGENT_INSIGHT_EVENT_FILE: eventFile } : {}),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(major === 2
        ? { ...config, plugins: [...(config.plugins || []), directory] }
        : { ...config, plugin: [...new Set([...(config.plugin || []), plugin])] }),
    },
  }
}

function createOpencodeEventReader(token, { onReady, onSession, onEvent, onModel, onTrigger }) {
  let buffer = ''
  let ready = false
  let sessionId = null
  let signalCount = 0
  let completed = false
  return {
    get ready() { return ready },
    get sessionId() { return sessionId },
    get completed() { return completed },
    get signalCount() { return signalCount },
    push(chunk) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      if (buffer.length > 64 * 1024) buffer = ''
      for (const line of lines) {
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame.protocol !== 1 || frame.token !== token) continue
        if (frame.kind === 'ready' && !ready) { ready = true; onReady(); continue }
        if (!ready) continue
        if (frame.kind === 'session' && !sessionId && typeof frame.sessionId === 'string') {
          sessionId = frame.sessionId
          onSession(sessionId)
        } else if (frame.kind === 'event' && sessionId && frame.sessionId === sessionId && frame.signal) {
          signalCount++
          onEvent(frame.signal)
        } else if (frame.kind === 'model' && sessionId && frame.sessionId === sessionId) {
          onModel?.(frame.model)
        } else if (frame.kind === 'trigger' && sessionId && frame.sessionId === sessionId) {
          onTrigger?.(frame.skillName)
        } else if (frame.kind === 'finished' && sessionId && frame.sessionId === sessionId) {
          completed = true
        }
      }
    },
  }
}

module.exports = { prepareOpencodeEventChannel, createOpencodeEventReader }
