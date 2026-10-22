'use strict'

const { loadGitSourcePolicyModule, readConfiguredGitSource } = require('../source-policy-registry.cjs')
const { loadProjectConfig } = require('../project-config.cjs')
const { SweBenchGitSourcePolicy: PackagePolicy, MIRRORS } = loadGitSourcePolicyModule('swe-bench')

class SweBenchGitSourcePolicy extends PackagePolicy {
  constructor(options) {
    super({ ...options, readGitSource: () => readConfiguredGitSource('swe-bench', options) })
  }
}

async function prepareCaseImage(task, { docker, workDir, signal, imageConfig }) {
  const { SweBenchImageResolver } = require('./swe-bench-images.cjs')
  const resolver = new SweBenchImageResolver({
    config: imageConfig || (() => loadProjectConfig('executor').benchmarks['swe-bench'].images),
    processRunner: (_file, args, options) => docker(args, options),
  })
  const resolution = await resolver.resolve(task.execution.environment.image, task.task.benchmarkPayload?.instanceId, workDir, signal, { expectedArch: task.execution.environment.arch })
  const image = JSON.parse((await docker(['image', 'inspect', resolution.localImageId || resolution.pinnedImage], { signal })).stdout)[0]
  return { image, resolution }
}

module.exports = { SweBenchGitSourcePolicy, MIRRORS, prepareCaseImage }
