'use strict'

const { loadGitSourcePolicyModule } = require('../source-policy-registry.cjs')
const { readLocalSetting } = require('../git-source.cjs')
const { SweBenchGitSourcePolicy: PackagePolicy, MIRRORS } = loadGitSourcePolicyModule('swe-bench')

class SweBenchGitSourcePolicy extends PackagePolicy {
  constructor(options) {
    super({ ...options, readLocalSetting })
  }
}

module.exports = { SweBenchGitSourcePolicy, MIRRORS }
