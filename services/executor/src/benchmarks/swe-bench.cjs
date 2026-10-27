'use strict'

const { loadGitSourcePolicyModule, readConfiguredGitSource } = require('../source-policy-registry.cjs')
const { loadProjectConfig } = require('../project-config.cjs')
const error = (code, message) => Object.assign(new Error(message), { code })
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

async function prepareCaseWorkspace(task, { exec }) {
  const revision = task.workspace.revision
  if (!/^[a-f0-9]{40}$/.test(revision)) throw error('WORKSPACE_REVISION_MISMATCH', 'SWE-bench 数据集基线不是有效的 Git commit')
  const head = (await exec(['git', 'rev-parse', 'HEAD'], 'workspace-head')).stdout.trim()
  if (!/^[a-f0-9]{40}$/.test(head)) throw error('WORKSPACE_REVISION_MISMATCH', 'Case 镜像工作区没有有效的 Git HEAD')
  await exec(['git', 'cat-file', '-e', `${revision}^{commit}`], 'workspace-base')
  await exec(['git', 'merge-base', '--is-ancestor', revision, head], 'workspace-ancestry')
  const status = await exec(['git', 'status', '--porcelain'], 'workspace-status')
  if (status.stdout.trim()) throw error('WORKSPACE_REVISION_MISMATCH', 'Case 镜像初始工作树存在未提交文件，请检查镜像构建；执行端不会自动清理镜像源码')
  // Official images commit setup changes after base_commit; resetting would undo that setup.
  return { baseCommit: head, datasetRevision: revision }
}

module.exports = { SweBenchGitSourcePolicy, MIRRORS, prepareCaseImage, prepareCaseWorkspace }
