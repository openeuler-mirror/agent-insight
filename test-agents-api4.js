const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const ex = await prisma.execution.findMany({
    select: { id: true, agentName: true, timestamp: true }
  });
  console.log(ex);
}
main().catch(console.error).finally(() => prisma.$disconnect());
