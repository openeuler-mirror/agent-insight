#!/usr/bin/env node

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const {
  ensureEnvFile,
  ensureDataDirectory,
  runCommand,
  getDataRoot,
  migrateDataIfNeeded
} = require('./utils.js')
const { syncGeneratedPrismaClient } = require('./sync-prisma-client.js')

const PACKAGE_ROOT = path.resolve(__dirname, '..')

// Ensure the standalone bundle's sharp (next/image) native binary matches the
// CURRENT install platform. The published tarball ships the binary of whatever
// platform built it; on a different OS/arch we swap in the one npm just resolved
// for this machine, so the package is build-anywhere / run-anywhere (online install).
function syncStandaloneSharp(packageRoot, standaloneDir) {
  try {
    const target = `${process.platform}-${process.arch}` // e.g. win32-x64, darwin-arm64, linux-x64
    const standaloneImg = path.join(standaloneDir, 'node_modules', '@img')
    if (!fs.existsSync(standaloneImg)) return // sharp not bundled in standalone; nothing to do

    // Find an @img dir that already has THIS platform's sharp (installed by npm for the user)
    const candidates = [
      path.join(packageRoot, 'node_modules', '@img'), // package's own deps
      path.join(packageRoot, '..', '@img'),           // hoisted to consumer root (unscoped pkg)
      path.join(packageRoot, '..', '..', '@img'),     // hoisted (scoped pkg layout)
    ]
    const sourceImg = candidates.find((c) => fs.existsSync(path.join(c, `sharp-${target}`)))
    if (!sourceImg) {
      console.log(`⚠️  Platform sharp (sharp-${target}) not found; leaving bundled @img unchanged`)
      return
    }

    const wanted = [`sharp-${target}`, `sharp-libvips-${target}`]
    for (const name of wanted) {
      const src = path.join(sourceImg, name)
      const dst = path.join(standaloneImg, name)
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.cpSync(src, dst, { recursive: true })
        console.log(`✓ Synced @img/${name} into standalone`)
      }
    }

    // Only prune mismatched binaries once the correct one is confirmed present
    if (fs.existsSync(path.join(standaloneImg, `sharp-${target}`))) {
      for (const entry of fs.readdirSync(standaloneImg)) {
        if (entry.startsWith('sharp-') && !wanted.includes(entry) && !entry.includes('colour')) {
          fs.rmSync(path.join(standaloneImg, entry), { recursive: true, force: true })
          console.log(`✓ Removed mismatched @img/${entry} from standalone`)
        }
      }
    }
  } catch (err) {
    console.log(`⚠️  sharp sync skipped: ${err.message}`)
  }
}

console.log('=== Agent-Insight Post-Install Initialization ===\n')

try {
  migrateDataIfNeeded()
  console.log()

  ensureEnvFile()
  console.log()

  ensureDataDirectory()
  console.log()

  const dataRoot = getDataRoot()
  const dbPath = path.join(dataRoot, 'data', 'witty_insight.db')
  const dbUrl = `file:${dbPath}`
  process.env.DATABASE_URL = dbUrl
  const standaloneDir = path.join(PACKAGE_ROOT, '.next', 'standalone')

  console.log('Generating Prisma client...')
  execSync('npx prisma generate', {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl }
  })
  syncGeneratedPrismaClient(PACKAGE_ROOT, standaloneDir)
  console.log('✓ Prisma client generated')
  console.log()

  console.log('Syncing database schema...')
  try {
    execSync('node scripts/prepare-ras-sqlite-schema.js', {
      stdio: 'inherit',
      cwd: PACKAGE_ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl }
    })
    execSync('npx prisma db push', {
      stdio: 'inherit',
      cwd: PACKAGE_ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl }
    })
    console.log('✓ Database schema synced')
  } catch (e) {
    // prisma 在迁移会删用户数据（删表/删列/加唯一约束）时拒绝执行并退出 1。
    // 这种情况绝不能让整个 npm install 失败——旧库照常可用，给出恢复指引即可。
    console.log('⚠️  Database schema sync skipped: prisma db push failed.')
    console.log(`   现有数据库 ${dbPath}`)
    console.log('   里可能存在新 schema 需要删除的数据（prisma 拒绝破坏性变更）。')
    console.log('   恢复方式（二选一）：')
    console.log('   1) 备份后原地迁移（接受丢弃冲突项）：')
    console.log(`        cp "${dbPath}" "${dbPath}.bak"`)
    console.log(`        DATABASE_URL="${dbUrl}" npx prisma db push --accept-data-loss`)
    console.log('   2) 全新开始：把旧库移走，重新 start 即可自动建库。')
    console.log('   注意：schema 未同步时服务仍可启动，但部分新功能可能报错。')
  }
  console.log()

  if (fs.existsSync(standaloneDir)) {
    console.log('Setting up standalone environment...')

    const staticDir = path.join(PACKAGE_ROOT, '.next', 'static')
    const standaloneStaticDir = path.join(standaloneDir, '.next', 'static')

    if (fs.existsSync(staticDir) && !fs.existsSync(standaloneStaticDir)) {
      fs.mkdirSync(path.dirname(standaloneStaticDir), { recursive: true })
      fs.cpSync(staticDir, standaloneStaticDir, { recursive: true })
      console.log('✓ Static files copied to standalone')
    }

    const publicDir = path.join(PACKAGE_ROOT, 'public')
    const standalonePublicDir = path.join(standaloneDir, 'public')

    if (fs.existsSync(publicDir) && !fs.existsSync(standalonePublicDir)) {
      fs.cpSync(publicDir, standalonePublicDir, { recursive: true })
      console.log('✓ Public files copied to standalone')
    }

    const standaloneNodeModules = path.join(standaloneDir, 'node_modules')
    const standaloneClientDir = path.join(standaloneNodeModules, '.prisma', 'client')

    syncStandaloneSharp(PACKAGE_ROOT, standaloneDir)

    const pgDir = path.join(PACKAGE_ROOT, 'node_modules', 'pg')
    if (fs.existsSync(pgDir)) {
      if (!fs.existsSync(standaloneNodeModules)) {
        fs.mkdirSync(standaloneNodeModules, { recursive: true })
      }
      const standalonePgDir = path.join(standaloneNodeModules, 'pg')
      if (!fs.existsSync(standalonePgDir)) {
        fs.cpSync(pgDir, standalonePgDir, { recursive: true })
        console.log('✓ pg module copied to standalone')
      }
    }

    const chunksDir = path.join(standaloneDir, '.next', 'server', 'chunks')
    if (fs.existsSync(chunksDir)) {
      const chunkFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.js'))
      let foundPrismaHash = null
      let foundPgHash = null

      for (const file of chunkFiles) {
        const filePath = path.join(chunksDir, file)
        const content = fs.readFileSync(filePath, 'utf8')

        if (!foundPrismaHash) {
          const prismaHashMatch = content.match(/@prisma\/client-([a-f0-9]+)/)
          if (prismaHashMatch) {
            foundPrismaHash = prismaHashMatch[1]
          }
        }

        if (!foundPgHash) {
          const pgHashMatch = content.match(/["']pg-([a-f0-9]+)["']/)
          if (pgHashMatch) {
            foundPgHash = pgHashMatch[1]
          }
        }

        if (foundPrismaHash && foundPgHash) {
          break
        }
      }

      if (foundPrismaHash) {
        const hashName = `@prisma/client-${foundPrismaHash}`
        const hashDir = path.join(standaloneNodeModules, hashName)

        if (!fs.existsSync(hashDir)) {
          fs.mkdirSync(path.dirname(hashDir), { recursive: true })
          if (process.platform === 'win32') {
            try {
              fs.symlinkSync(standaloneClientDir, hashDir, 'junction')
              console.log(`✓ Created junction: ${hashName} -> .prisma/client`)
            } catch (err) {
              console.log(`⚠️  Could not create junction on Windows: ${err.message}`)
              console.log(`   Falling back to copying directory...`)
              fs.cpSync(standaloneClientDir, hashDir, { recursive: true })
              console.log(`✓ Copied directory: ${hashName}`)
            }
          } else {
            fs.symlinkSync(standaloneClientDir, hashDir, 'dir')
            console.log(`✓ Created symlink: ${hashName} -> .prisma/client`)
          }
        }
      } else {
        console.log('⚠️  Could not find Prisma hash in build output')
      }

      if (foundPgHash) {
        const pgHashName = `pg-${foundPgHash}`
        const pgHashDir = path.join(standaloneNodeModules, pgHashName)
        const pgTargetDir = path.join(standaloneNodeModules, 'pg')

        if (!fs.existsSync(pgHashDir) && fs.existsSync(pgTargetDir)) {
          if (process.platform === 'win32') {
            try {
              fs.symlinkSync(pgTargetDir, pgHashDir, 'junction')
              console.log(`✓ Created junction: ${pgHashName} -> pg`)
            } catch (err) {
              console.log(`⚠️  Could not create junction on Windows: ${err.message}`)
              console.log(`   Falling back to copying directory...`)
              fs.cpSync(pgTargetDir, pgHashDir, { recursive: true })
              console.log(`✓ Copied directory: ${pgHashName}`)
            }
          } else {
            fs.symlinkSync(pgTargetDir, pgHashDir, 'dir')
            console.log(`✓ Created symlink: ${pgHashName} -> pg`)
          }
        }
      } else {
        console.log('⚠️  Could not find pg hash in build output')
      }
    }
    console.log()
  }

  console.log('=== Initialization Complete ===')
  console.log('\nStart the service with:')
  console.log('  npx agent-insight start')
  console.log('\nOr specify a custom port:')
  console.log('  npx agent-insight start --port 3001')
  console.log('\nAccess the dashboard at: http://localhost:3000')
} catch (error) {
  console.error('\n❌ Initialization failed:', error.message)
  process.exit(1)
}
