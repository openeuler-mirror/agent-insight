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

const fs = require('fs')
const path = require('path')

function findDependencyNodeModules(packageRoot, dependencyName) {
  const dependencyPackage = require.resolve(`${dependencyName}/package.json`, {
    paths: [packageRoot]
  })
  let current = path.dirname(dependencyPackage)

  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'node_modules') return current
    current = path.dirname(current)
  }

  throw new Error(`Could not locate node_modules for ${dependencyName}`)
}

function replaceDirectory(source, destination) {
  if (path.resolve(source) === path.resolve(destination)) return false
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.rmSync(destination, { recursive: true, force: true })
  fs.cpSync(source, destination, { recursive: true })
  return true
}

function syncGeneratedPrismaClient(packageRoot, standaloneDir) {
  const source = path.join(packageRoot, 'node_modules', '.prisma', 'client')
  if (!fs.existsSync(source)) {
    throw new Error(`Generated Prisma client not found at ${source}`)
  }

  const dependencyNodeModules = findDependencyNodeModules(packageRoot, '@prisma/client')
  const runtimeTarget = path.join(dependencyNodeModules, '.prisma', 'client')
  if (replaceDirectory(source, runtimeTarget)) {
    console.log('✓ Prisma client synced to resolved @prisma/client runtime')
  }

  if (standaloneDir && fs.existsSync(standaloneDir)) {
    const standaloneTarget = path.join(standaloneDir, 'node_modules', '.prisma', 'client')
    if (replaceDirectory(source, standaloneTarget)) {
      console.log('✓ Prisma client copied to standalone')
    }
  }
}

module.exports = { findDependencyNodeModules, syncGeneratedPrismaClient }
