#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client')

async function prepareRasSqliteSchema(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl || !String(databaseUrl).startsWith('file:')) {
    return { status: 'skipped', reason: 'not-sqlite' }
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  })

  try {
    const tables = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'RasAnomalyEvent'",
    )
    if (!Array.isArray(tables) || tables.length === 0) {
      return { status: 'skipped', reason: 'table-missing' }
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
    return { status: 'ready' }
  } finally {
    await prisma.$disconnect()
  }
}

async function run() {
  const result = await prepareRasSqliteSchema()
  if (result.status === 'ready') {
    console.log('✓ Agent RAS SQLite schema preflight complete')
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(`❌ Agent RAS SQLite schema preflight failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { prepareRasSqliteSchema }
