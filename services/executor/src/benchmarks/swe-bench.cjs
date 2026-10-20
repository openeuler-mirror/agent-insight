'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { GitSourcePolicy } = require('../git-source.cjs')
const { loadProjectConfig, warnLegacy } = require('../project-config.cjs')

const MIRRORS = Object.freeze({
  'astropy/astropy': 'mirrors/astropy',
  'django/django': 'mirrors/django',
  'matplotlib/matplotlib': 'mirrors/matplotlib',
  'mwaskom/seaborn': 'mirrors/seaborn',
  'pallets/flask': 'mirrors/flask',
  'psf/requests': 'mirrors/requests',
  'pydata/xarray': 'mirrors/xarray',
  'pylint-dev/pylint': 'mirrors_PyCQA/pylint',
  'pytest-dev/pytest': 'mirrors/pytest',
  'scikit-learn/scikit-learn': 'mirrors/scikit-learn',
  'sphinx-doc/sphinx': 'mirrors/sphinx',
  'sympy/sympy': 'mirrors/sympy',
})

class SweBenchGitSourcePolicy extends GitSourcePolicy {
  constructor({ home, env = process.env, config }) {
    super()
    this.home = home
    this.env = env
    this.config = config
  }

  resolve(spec) {
    const original = new URL(spec.repository)
    const repo = original.pathname.replace(/^\//, '').replace(/\.git$/, '')
    if (original.protocol !== 'https:' || original.hostname !== 'github.com'
      || original.username || original.password || original.search || original.hash
      || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo)
      || repo.split('/').some((part) => part === '.' || part === '..')) {
      throw new Error('SWE-bench repository must be a GitHub owner/repo URL')
    }
    warnLegacy('executor', this.env)
    try {
      if (/^\s*(?:export\s+)?SWE_BENCH_GIT_SOURCE\s*=/m.test(fs.readFileSync(path.join(this.home, '.env'), 'utf8'))) {
        warnLegacy('executor', { SWE_BENCH_GIT_SOURCE: '' })
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const config = this.config || loadProjectConfig('executor', { env: this.env })
    const configured = config.benchmarks['swe-bench'].gitSource || ''
    const remotes = []
    let cachePath = null
    if (/^https?:\/\//i.test(configured)) {
      const root = new URL(configured)
      if (root.username || root.password || root.search || root.hash) {
        throw new Error('benchmarks.swe-bench.gitSource: URL must not contain credentials, query or fragment')
      }
      root.pathname = `${root.pathname.replace(/\/$/, '')}/${repo}.git`
      remotes.push({ name: 'configured', url: root.href })
    } else if (configured) {
      const expanded = configured.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, os.homedir())
      if (!path.isAbsolute(expanded)) {
        throw new Error('benchmarks.swe-bench.gitSource: use an absolute local directory or HTTP(S) Git root URL')
      }
      cachePath = path.join(expanded, `${repo}.git`)
    }
    const mirror = MIRRORS[repo.toLowerCase()]
    if (mirror) remotes.push({ name: 'gitee', url: `https://gitee.com/${mirror}.git` })
    remotes.push({ name: 'github', url: spec.repository })
    return { cachePath, remotes }
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
