'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const { normalizeAgentOptions } = require('./index.cjs')

// 固定历史协议兼容；新 CLI 参数直接透传，不在此登记。
const historicalMctsKeys = Object.freeze({
  maxIters: 'max-iters',
  maxTurnsInit: 'max-turns-init',
  maxTurnsStep: 'max-turns-step',
  maxTurnsAuthor: 'max-turns-author',
  maxTurnsAuthorStep: 'max-turns-author-step',
  tokenFuseLimit: 'token-fuse-limit',
})

function proposeOptionMigration(savedDefinition, currentDefinition, input) {
  try {
    const saved = normalizeAgentOptions(input)
    if (!saved || saved.runtimeKey !== 'mcts' || savedDefinition?.runtimeKey !== 'mcts'
      || savedDefinition.definitionDigest !== saved.definitionDigest || currentDefinition.runtimeKey !== 'mcts'
      || currentDefinition.configuration?.structure !== 'flat' || currentDefinition.configuration.delivery !== 'argv'
      || saved.definitionDigest === currentDefinition.definitionDigest) return undefined
    const knownKeys = new Set([
      ...(savedDefinition.parameters || []).map(field => field.key),
      ...Object.keys(savedDefinition.configuration?.defaults || {}),
    ])
    const values = {}
    const changes = []
    for (const [key, value] of Object.entries(saved.values)) {
      const next = Object.hasOwn(historicalMctsKeys, key) ? historicalMctsKeys[key] : key
      if (next !== key && !knownKeys.has(key)) return undefined
      if (Object.hasOwn(values, next)) return undefined
      values[next] = value
      if (next !== key) changes.push({ from: key, to: next, value })
    }
    if (!changes.length) return undefined
    const options = normalizeAgentOptions({ version: 2, runtimeKey: currentDefinition.runtimeKey,
      definitionDigest: currentDefinition.definitionDigest, values }, currentDefinition)
    return { options, changes }
  } catch { return undefined }
}

module.exports = { proposeOptionMigration }
