const { PrismaClient } = require('@prisma/client');

async function removeLegacySummary(databaseUrl) {
  if (!databaseUrl?.startsWith('file:')) return false;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    return await db.$transaction(async tx => {
      const columns = await tx.$queryRawUnsafe('PRAGMA table_info("TraceDatasetGenerationJob")');
      if (!columns.some(column => column.name === 'summaryJson')) return false;
      await tx.$executeRawUnsafe('ALTER TABLE "TraceDatasetGenerationJob" DROP COLUMN "summaryJson"');
      return true;
    });
  } finally { await db.$disconnect(); }
}

module.exports = { removeLegacySummary };
if (require.main === module) removeLegacySummary(process.env.DATABASE_URL)
  .then(changed => { if (changed) console.log('Removed legacy Trace dataset summary storage; jobs and datasets preserved.'); })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
