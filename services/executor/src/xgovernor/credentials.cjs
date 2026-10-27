'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { parseEnv } = require('node:util')

function parse(text) {
  if (parseEnv) return parseEnv(text)
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.lastIndexOf(value[0])
      if (end === 0) continue
      value = value.slice(1, end)
    } else value = value.split('#')[0].trim()
    values[match[1]] = value
  }
  return values
}
function collectorEnvironment(env = process.env) {
  const home = env.AGENT_INSIGHT_HOME || path.join(os.homedir(), '.agent-insight')
  try { return { ...parse(fs.readFileSync(path.join(home, '.env'), 'utf8')), ...env } } catch { return { ...env } }
}
function traceApiKey(config, env = process.env) {
  return collectorEnvironment(env)[config.traceApiKeyEnv] || ''
}
module.exports = { collectorEnvironment, traceApiKey }
