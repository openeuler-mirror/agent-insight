const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const agents = await prisma.registeredAgent.findMany();
  console.log(agents);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const agent of agents) {
    const todayCalls = await prisma.execution.count({
        where: { agentName: agent.name, timestamp: { gte: today } }
    });
    console.log("Calls for", agent.name, "is", todayCalls);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
