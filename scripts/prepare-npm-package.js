#!/usr/bin/env node
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

function copyDirIfMissing(sourceDir, targetDir, label) {
  if (!fs.existsSync(sourceDir) || fs.existsSync(targetDir)) {
    return false
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  fs.cpSync(sourceDir, targetDir, { recursive: true })
  console.log(`✓ ${label} copied to standalone`)
  return true
}

function copyBenchmarkExecutionRuntime(packageRoot, standaloneDir) {
  for (const directory of ['packages/project-config', 'packages/benchmark-protocol', 'packages/agent-runtime', 'services/executor/src', 'services/executor/runtimes', 'agent_fault_injection']) {
    const source = path.join(packageRoot, directory)
    if (!fs.existsSync(source)) continue
    const destination = path.join(standaloneDir, directory)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(source, destination, { recursive: true })
  }
  const executorCatalog = path.join(packageRoot, 'generated/benchmark-catalog/executors.cjs')
  const executorFiles = fs.existsSync(executorCatalog) ? require(executorCatalog).generatedExecutorPackageFiles : []
  for (const file of ['scripts/xgovernor.cjs', 'scripts/reliability-client.cjs', 'scripts/install-ras-client.js', 'scripts/agent-insight-home.cjs', 'scripts/lib/fi-python-runtime.js', 'scripts/agent-trace-collectors/shared/trace-transport.cjs', 'generated/benchmark-catalog/executors.cjs', ...executorFiles]) {
    const source = path.join(packageRoot, file)
    if (!fs.existsSync(source)) continue
    const destination = path.join(standaloneDir, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
}

// Local/temp & non-runtime project dirs that `next build` sweeps into standalone.
// `files` whitelist makes .npmignore unable to drop them, so we delete physically.
// Runs on every `npm pack`/`npm publish` via the prepack hook.
const STANDALONE_JUNK_DIRS = [
  '.git',
  '.agents',
  '.codex',
  'agent_ras',
  'exclude',
  'tests',
  'test',
  'skillbench',
  'features',
  'tools',
  'docs',
  'design',
  'data',
  'logs',
  'src',
  'skills',
]
const STANDALONE_JUNK_FILES = [
  '.env',
  '.env.local',
  'server.log',
  path.join('prisma', 'dev.db'),
  path.join('prisma', 'dev.db-journal'),
  path.join('prisma', 'dev.db-shm'),
  path.join('prisma', 'dev.db-wal'),
]
const RUNTIME_SYSTEM_SKILLS = {
  'agent-debug-diagnosis': [
    'SKILL.md',
    path.join('references', '01-input-and-extraction.md'),
    path.join('references', '02-error-taxonomy.md'),
    path.join('references', '03-phase-analysis.md'),
    path.join('references', '04-output-schema.md'),
    path.join('references', '05-one-click-workflow.md'),
    path.join('references', '06-follow-up-workflow.md'),
    path.join('references', '07-targeted-workflow.md'),
    path.join('references', '08-detector-reconciliation.md'),
    path.join('scripts', 'detector_runner.py'),
    path.join('scripts', 'detector_validate.py'),
    path.join('scripts', 'agentdebug_inspect.py'),
    path.join('detectors', 'trajectory', 'detector.json'),
    path.join('detectors', 'trajectory', 'detect.py'),
    path.join('scripts', 'agentdebug_common.py'),
    path.join('scripts', 'agentdebug_static.py'),
    path.join('scripts', 'agentdebug_validate.py'),
  ],
}

function pruneStandaloneJunk(standaloneDir) {
  for (const dir of STANDALONE_JUNK_DIRS) {
    const target = path.join(standaloneDir, dir)
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true })
      console.log(`✓ Pruned ${dir}/ from standalone`)
    }
  }
  for (const file of STANDALONE_JUNK_FILES) {
    const target = path.join(standaloneDir, file)
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true })
      console.log(`✓ Pruned ${file} from standalone`)
    }
  }
  for (const entry of fs.readdirSync(standaloneDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.tgz')) continue
    fs.rmSync(path.join(standaloneDir, entry.name), { force: true })
    console.log(`✓ Pruned ${entry.name} from standalone`)
  }
}

function prunePythonBytecode(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') {
        fs.rmSync(target, { recursive: true, force: true })
      } else {
        prunePythonBytecode(target)
      }
    } else if (entry.isFile() && (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo'))) {
      fs.rmSync(target, { force: true })
    }
  }
}

function copyRuntimeSystemSkills(packageRoot, standaloneDir) {
  const sourceRoot = path.join(packageRoot, 'skills')
  const targetRoot = path.join(standaloneDir, 'skills')

  for (const skillName of Object.keys(RUNTIME_SYSTEM_SKILLS)) {
    const sourceDir = path.join(sourceRoot, skillName)
    const targetDir = path.join(targetRoot, skillName)

    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Missing runtime system skill: ${sourceDir}`)
    }

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true })
    }

    fs.mkdirSync(path.dirname(targetDir), { recursive: true })
    fs.cpSync(sourceDir, targetDir, { recursive: true })
    console.log(`✓ Runtime system skill copied: ${skillName}`)
  }
}

function copyLlamaIndexCollector(packageRoot, standaloneDir) {
  const sourceRoot = path.join(packageRoot, 'scripts', 'llamaindex_extension')
  const targetRoot = path.join(standaloneDir, 'scripts', 'llamaindex_extension')
  const sourcePackage = path.join(sourceRoot, 'src')
  const sourceReadme = path.join(
    packageRoot,
    'docs',
    'zh',
    'how-to',
    'observability',
    'llamaindex-trace-collector.md',
  )

  if (fs.existsSync(targetRoot)) {
    fs.rmSync(targetRoot, { recursive: true, force: true })
  }
  for (const required of [sourcePackage, sourceReadme]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing LlamaIndex collector runtime entry: ${required}`)
    }
  }
  fs.mkdirSync(targetRoot, { recursive: true })
  fs.cpSync(sourcePackage, path.join(targetRoot, 'src'), {
    recursive: true,
    filter: (candidate) => {
      const name = path.basename(candidate)
      return name !== '__pycache__'
        && name !== '.pytest_cache'
        && !name.endsWith('.pyc')
        && !fs.lstatSync(candidate).isSymbolicLink()
    },
  })
  fs.copyFileSync(sourceReadme, path.join(targetRoot, 'README.md'))
  prunePythonBytecode(targetRoot)
  console.log('✓ LlamaIndex collector copied to standalone')
}

function assertRuntimeSystemSkills(standaloneDir) {
  for (const [skillName, requiredFiles] of Object.entries(RUNTIME_SYSTEM_SKILLS)) {
    for (const relativeFile of requiredFiles) {
      const target = path.join(standaloneDir, 'skills', skillName, relativeFile)
      if (!fs.existsSync(target)) {
        throw new Error(`Missing runtime system skill file in standalone package: ${target}`)
      }
    }
  }
}

function copyLegalFiles(packageRoot, standaloneDir) {
  const files = ['LICENSE', 'NOTICE', 'LICENSE-MIT-Historical', 'Third_Party_Open_Source_Software_Notice.txt', 'licenses']
  for (const file of files) {
    const source = path.join(packageRoot, file)
    if (!fs.existsSync(source)) throw new Error(`Missing legal file: ${source}`)
  }
  fs.mkdirSync(standaloneDir, { recursive: true })
  for (const file of files) {
    fs.cpSync(path.join(packageRoot, file), path.join(standaloneDir, file), { recursive: true })
  }
}

function ensureStandalonePackage(packageRoot = process.cwd()) {
  const standaloneDir = path.join(packageRoot, '.next', 'standalone')
  if (!fs.existsSync(standaloneDir)) {
    throw new Error('Missing .next/standalone. Run `npm run build` before packaging.')
  }

  pruneStandaloneJunk(standaloneDir)
  copyLegalFiles(packageRoot, standaloneDir)
  copyRuntimeSystemSkills(packageRoot, standaloneDir)

  const staticDir = path.join(packageRoot, '.next', 'static')
  const standaloneStaticDir = path.join(standaloneDir, '.next', 'static')
  copyDirIfMissing(staticDir, standaloneStaticDir, 'Static files')

  const publicDir = path.join(packageRoot, 'public')
  const standalonePublicDir = path.join(standaloneDir, 'public')
  copyDirIfMissing(publicDir, standalonePublicDir, 'Public files')

  const scriptsDir = path.join(packageRoot, 'scripts')
  const standaloneScriptsDir = path.join(standaloneDir, 'scripts')
  copyDirIfMissing(scriptsDir, standaloneScriptsDir, 'Scripts')
  copyBenchmarkExecutionRuntime(packageRoot, standaloneDir)
  fs.mkdirSync(path.join(standaloneDir, 'config', 'benchmark'), { recursive: true })
  for (const scope of ['platform', 'evaluator', 'executor']) {
    const source = path.join(packageRoot, 'config', 'benchmark', `${scope}.yaml`)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(standaloneDir, 'config', 'benchmark', `${scope}.yaml`))
  }
  copyLlamaIndexCollector(packageRoot, standaloneDir)

  const prismaDir = path.join(packageRoot, 'prisma')
  const standalonePrismaDir = path.join(standaloneDir, 'prisma')
  copyDirIfMissing(prismaDir, standalonePrismaDir, 'Prisma files')

  if (!fs.existsSync(standaloneStaticDir)) {
    throw new Error('Missing .next/static in standalone package.')
  }

  const standaloneServer = path.join(standaloneDir, 'server.js')
  if (!fs.existsSync(standaloneServer)) {
    throw new Error('Missing standalone server.js in .next/standalone.')
  }

  assertRuntimeSystemSkills(standaloneDir)
  const llamaIndexRuntimeFiles = [
    path.join('scripts', 'llamaindex_extension', 'src', 'agent_insight_llamaindex', '_bootstrap', 'sitecustomize.py'),
    path.join('scripts', 'llamaindex_extension', 'src', 'agent_insight_llamaindex', '__init__.py'),
    path.join('scripts', 'llamaindex_extension', 'README.md'),
  ]
  for (const relativeFile of llamaIndexRuntimeFiles) {
    const target = path.join(standaloneDir, relativeFile)
    if (!fs.existsSync(target)) {
      throw new Error(`Missing LlamaIndex collector runtime file in standalone package: ${target}`)
    }
  }

  return standaloneDir
}

if (require.main === module) {
  try {
    const standaloneDir = ensureStandalonePackage()
    console.log(`✓ Standalone package prepared at ${standaloneDir}`)
  } catch (error) {
    console.error(`❌ ${error.message}`)
    process.exit(1)
  }
}

module.exports = {
  copyLegalFiles,
  copyBenchmarkExecutionRuntime,
  copyLlamaIndexCollector,
  ensureStandalonePackage,
}
