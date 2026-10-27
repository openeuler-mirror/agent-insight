'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const { normalizeAgentOptions } = require('./index.cjs')

function proposeOptionMigration(savedDefinition, currentDefinition, input) {
  try {
    const saved = normalizeAgentOptions(input)
    if (!saved || !savedDefinition || savedDefinition.runtimeKey !== saved.runtimeKey
      || savedDefinition.definitionDigest !== saved.definitionDigest || currentDefinition.runtimeKey !== saved.runtimeKey
      || currentDefinition.configuration?.version !== 2 || saved.definitionDigest === currentDefinition.definitionDigest) return undefined
    const options = normalizeAgentOptions({ version: 2, runtimeKey: currentDefinition.runtimeKey,
      definitionDigest: currentDefinition.definitionDigest, values: saved.values }, currentDefinition)
    return { options }
  } catch { return undefined }
}

module.exports = { proposeOptionMigration }
