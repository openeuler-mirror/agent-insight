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
