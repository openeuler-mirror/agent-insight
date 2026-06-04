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

function pruneStandaloneJunk(standaloneDir) {
  for (const dir of STANDALONE_JUNK_DIRS) {
    const target = path.join(standaloneDir, dir)
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true })
      console.log(`✓ Pruned ${dir}/ from standalone`)
    }
  }
}

function ensureStandalonePackage(packageRoot = process.cwd()) {
  const standaloneDir = path.join(packageRoot, '.next', 'standalone')
  if (!fs.existsSync(standaloneDir)) {
    throw new Error('Missing .next/standalone. Run `npm run build` before packaging.')
  }

  pruneStandaloneJunk(standaloneDir)

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
