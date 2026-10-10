'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { readLocalSetting } = require('./git-source.cjs')

function loadCatalog() {
  const installed = path.join(__dirname, 'generated', 'benchmark-catalog', 'executors.cjs')
  return require(fs.existsSync(installed)
    ? installed
    : path.resolve(__dirname, '../../../generated/benchmark-catalog/executors.cjs'))
}

function loadGitSourcePolicyModule(benchmarkKey) {
  const descriptor = loadCatalog().generatedGitSourcePolicyDescriptors
    .find(item => item.benchmarkKey === benchmarkKey)
  if (!descriptor) throw new Error(`Git source policy not registered: ${benchmarkKey}`)
  return require(descriptor.modulePath)
}

function createGitSourcePolicies(context) {
  const policies = new Map()
  for (const descriptor of loadCatalog().generatedGitSourcePolicyDescriptors) {
    const implementation = require(descriptor.modulePath)
    if (typeof implementation.createGitSourcePolicy !== 'function') {
      throw new Error(`Git source policy factory missing: ${descriptor.benchmarkKey}`)
    }
    const policy = implementation.createGitSourcePolicy({ ...context, readLocalSetting })
    if (!policy || typeof policy.resolve !== 'function') {
      throw new Error(`Git source policy invalid: ${descriptor.benchmarkKey}`)
    }
    policies.set(descriptor.benchmarkKey, policy)
  }
  return policies
}

module.exports = { createGitSourcePolicies, loadGitSourcePolicyModule }
