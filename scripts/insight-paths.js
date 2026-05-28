const fs = require('fs')
const os = require('os')
const path = require('path')

function getPreferredInsightDir() {
  return path.join(os.homedir(), '.agent-insight')
}

function getLegacyInsightDir() {
  return path.join(os.homedir(), '.skill-insight')
}

function getExistingInsightDir() {
  const preferred = getPreferredInsightDir()
  const legacy = getLegacyInsightDir()
  if (fs.existsSync(preferred)) return preferred
  if (fs.existsSync(legacy)) return legacy
  return preferred
}

function getInsightEnvCandidates() {
  return [
    path.join(getPreferredInsightDir(), '.env'),
    path.join(getLegacyInsightDir(), '.env')
  ]
}

module.exports = {
  getPreferredInsightDir,
  getLegacyInsightDir,
  getExistingInsightDir,
  getInsightEnvCandidates
}
