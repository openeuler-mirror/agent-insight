#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client')

const OBSOLETE_BENCHMARK_COLUMNS = [
  ['ReliabilityClient', 'executorBaseUrl'],
  ['ReliabilityClient', 'executorReachability'],
  ['ReliabilityClient', 'executorCheckedAt'],
  ['BenchmarkCaseRun', 'executorBaseUrl'],
  ['BenchmarkDispatchOutbox', 'destinationBaseUrl'],
  ['BenchmarkDispatchOutbox', 'httpStatus'],
]

async function tableExists(prisma, tableName) {
  const tables = await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName,
  )
  return Array.isArray(tables) && tables.length > 0
}

async function dropObsoleteBenchmarkColumns(prisma) {
  const removed = []
  for (const [tableName, columnName] of OBSOLETE_BENCHMARK_COLUMNS) {
    if (!(await tableExists(prisma, tableName))) continue
    const columns = await prisma.$queryRawUnsafe(`PRAGMA table_info("${tableName}")`)
    if (!columns.some(column => column.name === columnName)) continue
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`,
    )
    removed.push(`${tableName}.${columnName}`)
  }
  return removed
}

async function prepareBenchmarkDispatchCommandId(prisma) {
  if (!(await tableExists(prisma, 'BenchmarkDispatchOutbox'))) return false
  const columns = await prisma.$queryRawUnsafe('PRAGMA table_info("BenchmarkDispatchOutbox")')
  const added = !columns.some(column => column.name === 'commandId')
  if (added) {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "BenchmarkDispatchOutbox" ADD COLUMN "commandId" TEXT',
    )
  }
  const duplicates = await prisma.$queryRawUnsafe(`
    SELECT "commandId", COUNT(*) AS "count"
    FROM "BenchmarkDispatchOutbox"
    WHERE "commandId" IS NOT NULL
    GROUP BY "commandId"
    HAVING COUNT(*) > 1
    LIMIT 1
  `)
  if (Array.isArray(duplicates) && duplicates.length > 0) {
    throw new Error(
      'BenchmarkDispatchOutbox contains duplicate commandId rows; back up and deduplicate them before schema sync',
    )
  }
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "BenchmarkDispatchOutbox_commandId_key"
    ON "BenchmarkDispatchOutbox"("commandId")
  `)
  return added
}

async function prepareRasSqliteSchema(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl || !String(databaseUrl).startsWith('file:')) {
    return { status: 'skipped', reason: 'not-sqlite' }
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  })

  try {
    const removedColumns = await dropObsoleteBenchmarkColumns(prisma)
    const commandIdAdded = await prepareBenchmarkDispatchCommandId(prisma)
    if (!(await tableExists(prisma, 'RasAnomalyEvent'))) {
      return removedColumns.length > 0 || commandIdAdded
        ? { status: 'ready', removedColumns, commandIdAdded }
        : { status: 'skipped', reason: 'table-missing' }
    }

    const columns = await prisma.$queryRawUnsafe('PRAGMA table_info("RasAnomalyEvent")')
    if (!columns.some(column => column.name === 'deliveryId')) {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "RasAnomalyEvent" ADD COLUMN "deliveryId" TEXT',
      )
    }

    const duplicates = await prisma.$queryRawUnsafe(`
      SELECT "taskId", "deliveryId", COUNT(*) AS "count"
      FROM "RasAnomalyEvent"
      WHERE "deliveryId" IS NOT NULL
      GROUP BY "taskId", "deliveryId"
      HAVING COUNT(*) > 1
      LIMIT 1
    `)
    if (Array.isArray(duplicates) && duplicates.length > 0) {
      throw new Error(
        'RasAnomalyEvent contains duplicate (taskId, deliveryId) rows; back up and deduplicate them before schema sync',
      )
    }

    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "RasAnomalyEvent_taskId_deliveryId_key"
      ON "RasAnomalyEvent"("taskId", "deliveryId")
    `)
    return { status: 'ready', removedColumns, commandIdAdded }
  } finally {
    await prisma.$disconnect()
  }
}

async function run() {
  const result = await prepareRasSqliteSchema()
  if (result.status === 'ready') {
    if (result.removedColumns?.length > 0) {
      console.log(`✓ Removed obsolete Benchmark columns: ${result.removedColumns.join(', ')}`)
    }
    if (result.commandIdAdded) {
      console.log('✓ Added BenchmarkDispatchOutbox.commandId')
    }
    console.log('✓ SQLite schema preflight complete')
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(`❌ Agent RAS SQLite schema preflight failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { prepareRasSqliteSchema }
