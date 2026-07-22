#!/usr/bin/env node

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

// Local/temp & non-runtime project dirs that `next build` sweeps into standalone.
// `files` whitelist makes .npmignore unable to drop them, so we delete physically.
// Runs on every `npm pack`/`npm publish` via the prepack hook.
const STANDALONE_JUNK_DIRS = ['exclude', 'tests', 'test', 'skillbench', 'features', 'tools', 'docs', 'data', 'src', 'skills']
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

function ensureStandalonePackage(packageRoot = process.cwd()) {
  const standaloneDir = path.join(packageRoot, '.next', 'standalone')
  if (!fs.existsSync(standaloneDir)) {
    throw new Error('Missing .next/standalone. Run `npm run build` before packaging.')
  }

  pruneStandaloneJunk(standaloneDir)
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
  ensureStandalonePackage,
}
