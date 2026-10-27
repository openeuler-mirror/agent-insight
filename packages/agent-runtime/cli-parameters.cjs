'use strict'

const reservedFlags = new Set(['--', '--mode', '--runtime', '--testbench', '--instance-id', '--task-id', '--split', '--output-dir', '--config', '--upstream', '--strict', '--model', '-m', '--agent', '--format', '--title', '--session', '--session-id', '--cwd', '--directory', '--port', '--hostname', '--attach', '--command', '--help', '--version'])

function validateCliFlag(value, flags = new Set()) {
  if (typeof value !== 'string' || !/^--[a-z][a-z0-9-]*$/.test(value) || reservedFlags.has(value) || flags.has(value)) {
    throw Object.assign(new TypeError(`不支持、保留或重复的启动参数：${value}`), { code: 'AGENT_OPTIONS_INVALID' })
  }
  flags.add(value)
}

function validateNativeCliKey(key, flags = new Set()) {
  const parameter = `--${key}`
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || reservedFlags.has(parameter) || flags.has(parameter)) {
    throw Object.assign(new TypeError(`不支持、保留或重复的启动参数：${parameter}`), { code: 'AGENT_OPTIONS_INVALID' })
  }
  flags.add(parameter)
  return parameter
}

module.exports = { validateCliFlag, validateNativeCliKey }
