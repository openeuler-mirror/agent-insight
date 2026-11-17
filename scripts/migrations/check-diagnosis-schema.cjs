const { PrismaClient } = require('@prisma/client');

async function check() {
  if (!process.env.DATABASE_URL?.startsWith('file:')) return;
  const db = new PrismaClient();
  try {
    const rows = await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    if (!rows.length) return;
    const columns = await db.$queryRawUnsafe('PRAGMA table_info("SkillOptPlanItem")');
    if (!rows.some(row => row.name === 'DiagnosisRun') || !columns.some(col => col.name === 'sourceRefsJson')) {
      throw new Error('Existing database needs a verified diagnosis migration. Stop writers and run scripts/migrations/diagnosis-inputs.py against the actual database with --apply and --backup before startup.');
    }
  } finally {
    await db.$disconnect();
  }
}
check().catch(error => { console.error(error.message); process.exitCode = 1; });
