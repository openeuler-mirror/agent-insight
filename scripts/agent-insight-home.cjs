const os = require('node:os')
const path = require('node:path')

function assertSupportedHomeEnv(env = process.env) {
  if (env.AGENT_INSIGHT_DATA_DIR) {
    throw new Error('AGENT_INSIGHT_DATA_DIR is no longer supported; rename it to AGENT_INSIGHT_HOME and unset AGENT_INSIGHT_DATA_DIR (keep the same root path).')
  }
}

function expandHomePath(value, home = os.homedir()) {
  return value.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, () => home)
}

function getAgentInsightHome(env = process.env, home = os.homedir()) {
  assertSupportedHomeEnv(env)
  return path.resolve(expandHomePath(env.AGENT_INSIGHT_HOME || path.join(home, '.agent-insight'), home))
}

function resolveDatabaseUrl(value, root = getAgentInsightHome()) {
  if (!value?.trim() || value === 'file:../data/witty_insight.db') {
    return `file:${path.join(root, 'data', 'witty_insight.db')}`
  }
  return value.startsWith('file:') ? `file:${expandHomePath(value.slice(5))}` : value
}

function resolveStartupDatabaseUrl(fileEnv, env = process.env, root = getAgentInsightHome(env)) {
  assertSupportedHomeEnv(env)
  assertSupportedHomeEnv(fileEnv)
  return resolveDatabaseUrl(env.DATABASE_URL ?? fileEnv.DATABASE_URL, root)
}

module.exports = { assertSupportedHomeEnv, expandHomePath, getAgentInsightHome, resolveDatabaseUrl, resolveStartupDatabaseUrl }
