'use strict'

const fs = require('node:fs')
const path = require('node:path')

class GitSourcePolicy {
  resolve(_spec) {
    throw new Error('GitSourcePolicy.resolve must be implemented')
  }
}

function readLocalSetting(name, home, env = process.env) {
  if (env[name] !== undefined) return env[name]
  let text
  try {
    text = fs.readFileSync(path.join(home, '.env'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
  let value = ''
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || match[1] !== name) continue
    const raw = match[2].trim()
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const end = raw.indexOf(raw[0], 1)
      if (end < 0 || !/^\s*(?:#.*)?$/.test(raw.slice(end + 1))) {
        throw new Error(`${name}: invalid quoted value`)
      }
      value = raw.slice(1, end)
    } else {
      value = raw.split('#', 1)[0].trim()
    }
  }
  return value
}

module.exports = { GitSourcePolicy, readLocalSetting }
