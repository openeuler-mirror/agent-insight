'use strict'

const os = require('node:os')
const path = require('node:path')
const { GitSourcePolicy, readLocalSetting } = require('../git-source.cjs')

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
  constructor({ home, env = process.env }) {
    super()
    this.home = home
    this.env = env
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
    const configured = String(readLocalSetting('SWE_BENCH_GIT_SOURCE', this.home, this.env)).trim()
    const remotes = []
    let cachePath = null
    if (/^https?:\/\//i.test(configured)) {
      const root = new URL(configured)
      if (root.username || root.password || root.search || root.hash) {
        throw new Error('SWE_BENCH_GIT_SOURCE: URL must not contain credentials, query or fragment')
      }
      root.pathname = `${root.pathname.replace(/\/$/, '')}/${repo}.git`
      remotes.push({ name: 'configured', url: root.href })
    } else if (configured) {
      const expanded = configured.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, os.homedir())
      if (!path.isAbsolute(expanded)) {
        throw new Error('SWE_BENCH_GIT_SOURCE: use an absolute local directory or HTTP(S) Git root URL')
      }
      cachePath = path.join(expanded, `${repo}.git`)
    }
    const mirror = MIRRORS[repo.toLowerCase()]
    if (mirror) remotes.push({ name: 'gitee', url: `https://gitee.com/${mirror}.git` })
    remotes.push({ name: 'github', url: spec.repository })
    return { cachePath, remotes }
  }
}

module.exports = { SweBenchGitSourcePolicy, MIRRORS }
