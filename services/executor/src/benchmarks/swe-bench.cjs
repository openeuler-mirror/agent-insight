'use strict'

const { loadGitSourcePolicyModule, readConfiguredGitSource } = require('../source-policy-registry.cjs')
const { SweBenchGitSourcePolicy: PackagePolicy, MIRRORS } = loadGitSourcePolicyModule('swe-bench')

class SweBenchGitSourcePolicy extends PackagePolicy {
  constructor(options) {
    super({ ...options, readGitSource: () => readConfiguredGitSource('swe-bench', options) })
  }
}

module.exports = { SweBenchGitSourcePolicy, MIRRORS }
