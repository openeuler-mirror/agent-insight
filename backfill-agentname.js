const { PrismaClient } = require('@prisma/client');
const { deriveOpencodeExecutionFields } = require('./node_modules/.prisma/client'); // No, need to read interactions from DB
const prisma = new PrismaClient();

async function main() {
  const sessions = await prisma.session.findMany({
    select: { taskId: true, interactions: true }
  });

  let updated = 0;
  for (const s of sessions) {
    if (s.interactions) {
      try {
        const inters = JSON.parse(s.interactions);
        let agentName = null;
        for (const i of inters) {
          if (i.agent) {
            agentName = i.agent;
            break;
          }
        }
        if (agentName) {
          const res = await prisma.execution.updateMany({
            where: { taskId: s.taskId },
            data: { agentName }
          });
          updated += res.count;
        }
      } catch (e) {}
    }
  }
  console.log(`Backfilled ${updated} executions with agentName`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
