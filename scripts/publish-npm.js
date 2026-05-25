#!/usr/bin/env node

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function runCommand(command, description, ignoreFailure = false) {
  console.log(`\n${description}...`)
  console.log(`$ ${command}`)
  try {
    execSync(command, { stdio: 'inherit' })
    console.log('✓ Success')
    return true
  } catch (error) {
    if (ignoreFailure) {
      console.log('⚠️  Warning: Command failed, but continuing...')
      return false
    }
    console.error('✗ Failed')
    process.exit(1)
  }
}

function isValidVersion(version) {
  const semverRegex = /^(\d+)\.(\d+)\.(\d+)(-([a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*))?(\+([a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*))?$/
  return semverRegex.test(version)
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?(?:\+(.+))?$/)
  if (!match) return null
  
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    build: match[5] || null
  }
}

function incrementVersion(version, type = 'patch') {
  const parsed = parseVersion(version)
  if (!parsed) {
    throw new Error(`Invalid version: ${version}`)
  }
  
  let { major, minor, patch, prerelease, build } = parsed
  
  if (type === 'major') {
    major++
    minor = 0
    patch = 0
    prerelease = null
  } else if (type === 'minor') {
    minor++
    patch = 0
    prerelease = null
  } else {
    patch++
    prerelease = null
  }
  
  let newVersion = `${major}.${minor}.${patch}`
  if (prerelease) newVersion += `-${prerelease}`
  if (build) newVersion += `+${build}`
  
  return newVersion
}

function addPrerelease(version, prereleaseType) {
  const parsed = parseVersion(version)
  if (!parsed) {
    throw new Error(`Invalid version: ${version}`)
  }
  
  let { major, minor, patch, prerelease } = parsed
  
  if (prerelease && prerelease.startsWith(prereleaseType)) {
    const match = prerelease.match(new RegExp(`^${prereleaseType}\\.(\\d+)$`))
    if (match) {
      const num = parseInt(match[1], 10) + 1
      prerelease = `${prereleaseType}.${num}`
    } else {
      prerelease = `${prereleaseType}.1`
    }
  } else {
    prerelease = `${prereleaseType}.1`
  }
  
  return `${major}.${minor}.${patch}-${prerelease}`
}

function setupStandalone() {
  console.log('\nSetting up standalone environment...')
  
  const packageRoot = process.cwd()
  const standaloneDir = path.join(packageRoot, '.next', 'standalone')
  
  if (!fs.existsSync(standaloneDir)) {
    console.log('⚠️  Standalone directory not found, skipping setup')
    return
  }
  
  const staticDir = path.join(packageRoot, '.next', 'static')
  const standaloneStaticDir = path.join(standaloneDir, '.next', 'static')
  
  if (fs.existsSync(staticDir) && !fs.existsSync(standaloneStaticDir)) {
    fs.mkdirSync(path.dirname(standaloneStaticDir), { recursive: true })
    execSync(`cp -r "${staticDir}" "${path.dirname(standaloneStaticDir)}/"`, { stdio: 'inherit' })
    console.log('✓ Static files copied to standalone')
  }
  
  const publicDir = path.join(packageRoot, 'public')
  const standalonePublicDir = path.join(standaloneDir, 'public')
  
  if (fs.existsSync(publicDir) && !fs.existsSync(standalonePublicDir)) {
    execSync(`cp -r "${publicDir}" "${standaloneDir}/"`, { stdio: 'inherit' })
    console.log('✓ Public files copied to standalone')
  }
  
  const scriptsDir = path.join(packageRoot, 'scripts')
  const standaloneScriptsDir = path.join(standaloneDir, 'scripts')
  
  if (fs.existsSync(scriptsDir) && !fs.existsSync(standaloneScriptsDir)) {
    execSync(`cp -r "${scriptsDir}" "${standaloneDir}/"`, { stdio: 'inherit' })
    console.log('✓ Scripts files copied to standalone')
  }
  
  const prismaDir = path.join(packageRoot, 'prisma')
  const standalonePrismaDir = path.join(standaloneDir, 'prisma')
  
  if (fs.existsSync(prismaDir) && !fs.existsSync(standalonePrismaDir)) {
    execSync(`cp -r "${prismaDir}" "${standaloneDir}/"`, { stdio: 'inherit' })
    console.log('✓ Prisma files copied to standalone')
  }
  
  const dirsToRemove = ['docs', 'data', 'src', 'skills']
  const filesToRemove = ['README.md', '.env', 'server.log', 'tsconfig.tsbuildinfo', 'package-lock.json']
  
  const prismaDbFile = path.join(standaloneDir, 'prisma', 'dev.db')
  if (fs.existsSync(prismaDbFile)) {
    fs.unlinkSync(prismaDbFile)
    console.log('✓ Removed prisma/dev.db from standalone')
  }
  
  const tgzFiles = fs.readdirSync(standaloneDir).filter(f => f.endsWith('.tgz'))
  for (const tgz of tgzFiles) {
    fs.unlinkSync(path.join(standaloneDir, tgz))
    console.log(`✓ Removed ${tgz} from standalone`)
  }
  
  for (const dir of dirsToRemove) {
    const dirPath = path.join(standaloneDir, dir)
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true })
      console.log(`✓ Removed ${dir}/ from standalone`)
    }
  }
  
  for (const file of filesToRemove) {
    const filePath = path.join(standaloneDir, file)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log(`✓ Removed ${file} from standalone`)
    }
  }
  
  const nodeModulesDir = path.join(standaloneDir, 'node_modules')
  if (fs.existsSync(nodeModulesDir)) {
    const devDepsToRemove = ['typescript', '@typescript-eslint', 'eslint', 'prettier']
    for (const dep of devDepsToRemove) {
      const depPath = path.join(nodeModulesDir, dep)
      if (fs.existsSync(depPath)) {
        fs.rmSync(depPath, { recursive: true, force: true })
        console.log(`✓ Removed ${dep} from standalone node_modules`)
      }
    }
    
    const imgDir = path.join(nodeModulesDir, '@img')
    if (fs.existsSync(imgDir)) {
      const platform = process.platform
      const arch = process.arch
      const keepPattern = `${platform}-${arch}`
      
      const imgSubDirs = fs.readdirSync(imgDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)
      
      for (const subDir of imgSubDirs) {
        if (!subDir.includes(keepPattern) && !subDir.includes('colour')) {
          const subDirPath = path.join(imgDir, subDir)
          fs.rmSync(subDirPath, { recursive: true, force: true })
          console.log(`✓ Removed @img/${subDir} from standalone (platform-specific)`)
        }
      }
    }
  }
  
  console.log('✓ Standalone setup complete')
}

function showHelp() {
  console.log(`
Usage: node scripts/publish-npm.js [options]

Options:
  --version <version>   Specify exact version (e.g., 0.1.0-beta, 1.0.0)
  --type <type>         Increment version type: patch, minor, major
  --prerelease <type>   Add prerelease suffix: alpha, beta, rc
  --tag <tag>           npm dist-tag (default: latest)
  --dry-run             Test without publishing
  --help                Show this help

Examples:
  # Specify exact version
  node scripts/publish-npm.js --version 0.1.0-beta

  # Auto increment patch version
  node scripts/publish-npm.js --type patch

  # Add prerelease suffix
  node scripts/publish-npm.js --type minor --prerelease beta
  # 1.0.0 -> 1.1.0-beta.1

  # Publish beta version with tag
  node scripts/publish-npm.js --version 1.0.0-beta.1 --tag beta

  # Dry run
  node scripts/publish-npm.js --version 1.0.0 --dry-run
`)
}

function main() {
  console.log('=== NPM Package Publishing Script ===\n')
  
  const args = process.argv.slice(2)
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp()
    process.exit(0)
  }
  
  const versionIndex = args.indexOf('--version')
  const typeIndex = args.indexOf('--type')
  const prereleaseIndex = args.indexOf('--prerelease')
  const tagIndex = args.indexOf('--tag')
  const dryRun = args.includes('--dry-run')
  
  const specifiedVersion = versionIndex !== -1 ? args[versionIndex + 1] : null
  const type = typeIndex !== -1 ? args[typeIndex + 1] : null
  const prereleaseType = prereleaseIndex !== -1 ? args[prereleaseIndex + 1] : null
  const npmTag = tagIndex !== -1 ? args[tagIndex + 1] : 'latest'
  
  if (specifiedVersion && type) {
    console.error('❌ Error: Cannot use both --version and --type together')
    process.exit(1)
  }
  
  if (!specifiedVersion && !type) {
    console.error('❌ Error: Must specify either --version or --type')
    showHelp()
    process.exit(1)
  }
  
  if (type && !['patch', 'minor', 'major'].includes(type)) {
    console.error('❌ Error: Invalid version type. Use: patch, minor, or major')
    process.exit(1)
  }
  
  if (specifiedVersion && !isValidVersion(specifiedVersion)) {
    console.error(`❌ Error: Invalid version format: ${specifiedVersion}`)
    console.error('   Expected format: X.Y.Z or X.Y.Z-prerelease (e.g., 1.0.0, 0.1.0-beta)')
    process.exit(1)
  }
  
  console.log('Configuration:')
  if (specifiedVersion) {
    console.log(`  Version: ${specifiedVersion}`)
  } else {
    console.log(`  Type: ${type}`)
    if (prereleaseType) {
      console.log(`  Prerelease: ${prereleaseType}`)
    }
  }
  console.log(`  npm tag: ${npmTag}`)
  console.log(`  Dry run: ${dryRun ? 'Yes' : 'No'}`)
  
  try {
    const packageJsonPath = path.join(process.cwd(), 'package.json')
    
    if (!fs.existsSync(packageJsonPath)) {
      console.error('❌ Error: package.json not found')
      process.exit(1)
    }
    
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    
    if (!packageJson.version) {
      console.error('❌ Error: package.json missing version field')
      process.exit(1)
    }
    
    const currentVersion = packageJson.version
    let newVersion
    
    if (specifiedVersion) {
      newVersion = specifiedVersion
    } else if (prereleaseType) {
      newVersion = addPrerelease(currentVersion, prereleaseType)
    } else {
      newVersion = incrementVersion(currentVersion, type)
    }
    
    console.log(`\nVersion: ${currentVersion} → ${newVersion}`)
    
    packageJson.version = newVersion
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')
    
    console.log(`✓ Updated package.json`)
    
    runCommand('npm ci', 'Installing dependencies')
    
    if (fs.existsSync('eslint.config.mjs')) {
      runCommand('npm run lint', 'Running linter', true)
    }
    
    runCommand('npm run build', 'Building project')
    
    setupStandalone()
    
    const prismaDbInSource = path.join(process.cwd(), 'prisma', 'dev.db')
    if (fs.existsSync(prismaDbInSource)) {
      const stats = fs.statSync(prismaDbInSource)
      if (stats.size === 0) {
        fs.unlinkSync(prismaDbInSource)
        console.log('✓ Removed empty prisma/dev.db')
      }
    }
    
    const tgzName = `${packageJson.name}-${newVersion}.tgz`
    const existingTgz = path.join(process.cwd(), tgzName)
    if (fs.existsSync(existingTgz)) {
      fs.unlinkSync(existingTgz)
    }
    
    runCommand('npm pack', 'Creating npm package')
    
    const tgzPath = path.join(process.cwd(), tgzName)
    if (fs.existsSync(tgzPath)) {
      const stats = fs.statSync(tgzPath)
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2)
      console.log(`\n📦 Package created: ${tgzName} (${sizeMB} MB)`)
    }
    
    if (dryRun) {
      console.log('\n=== Dry Run Complete ===')
      console.log(`Version: ${newVersion}`)
      console.log(`npm tag: ${npmTag}`)
      console.log(`Package: ${tgzName}`)
      console.log('\nTo publish, run without --dry-run flag')
    } else {
      try {
        execSync('npm whoami', { stdio: 'ignore' })
      } catch (error) {
        console.error('\n❌ Error: Not logged in to npm')
        console.error('Please run: npm login')
        process.exit(1)
      }
      
      const isScopedPackage = packageJson.name.startsWith('@')
      let publishCmd
      if (isScopedPackage) {
        publishCmd = npmTag === 'latest' 
          ? 'npm publish --access public' 
          : `npm publish --access public --tag ${npmTag}`
      } else {
        publishCmd = npmTag === 'latest' 
          ? 'npm publish' 
          : `npm publish --tag ${npmTag}`
      }
      
      runCommand(publishCmd, `Publishing to npm (${npmTag} tag)`)
      
      console.log('\n=== Publishing Complete ===')
      console.log(`\nPackage: ${packageJson.name}@${newVersion}`)
      console.log(`Tag: ${npmTag}`)
      console.log('\nInstall with:')
      if (npmTag === 'latest') {
        console.log(`  npm install ${packageJson.name}`)
      } else {
        console.log(`  npm install ${packageJson.name}@${npmTag}`)
      }
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message)
    process.exit(1)
  }
}

main()
