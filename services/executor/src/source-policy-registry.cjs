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

function readConfiguredGitSource(benchmarkKey, { home, env = process.env, config } = {}) {
  const { loadProjectConfig, warnLegacy, legacySettings } = require('./project-config.cjs')
  warnLegacy('executor', env)
  if (home) {
    try {
      const content = fs.readFileSync(path.join(home, '.env'), 'utf8')
      for (const name of Object.keys(legacySettings.executor)) {
        if (new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, 'm').test(content)) warnLegacy('executor', { [name]: '' })
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return (config || loadProjectConfig('executor', { env })).benchmarks[benchmarkKey]?.gitSource || ''
}

function createGitSourcePolicies(context) {
  const policies = new Map()
  for (const descriptor of loadCatalog().generatedGitSourcePolicyDescriptors) {
    const implementation = require(descriptor.modulePath)
    if (typeof implementation.createGitSourcePolicy !== 'function') {
      throw new Error(`Git source policy factory missing: ${descriptor.benchmarkKey}`)
    }
    const policy = implementation.createGitSourcePolicy({ ...context, readLocalSetting,
      readGitSource: () => readConfiguredGitSource(descriptor.benchmarkKey, context) })
    if (!policy || typeof policy.resolve !== 'function') {
      throw new Error(`Git source policy invalid: ${descriptor.benchmarkKey}`)
    }
    policies.set(descriptor.benchmarkKey, policy)
  }
  return policies
}

module.exports = { createGitSourcePolicies, loadGitSourcePolicyModule, readConfiguredGitSource }
