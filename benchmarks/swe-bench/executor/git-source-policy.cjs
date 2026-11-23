/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const os = require('node:os')
const path = require('node:path')

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

class SweBenchGitSourcePolicy {
  constructor({ home, env = process.env, readGitSource }) {
    this.readGitSource = readGitSource
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
    const configured = String(this.readGitSource?.() || '').trim()
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

function createGitSourcePolicy(context) {
  return new SweBenchGitSourcePolicy(context)
}

module.exports = { createGitSourcePolicy, SweBenchGitSourcePolicy, MIRRORS }
