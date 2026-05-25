const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const user = 'anonymous';
  const agents = await prisma.registeredAgent.findMany({ where: { user } });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const enrichedAgents = await Promise.all(agents.map(async (agent) => {
    const todayCalls = await prisma.execution.count({
        where: { user, agentName: agent.name, timestamp: { gte: today } }
    });
    return todayCalls;
  }));
  console.log(enrichedAgents);
}
main().catch(console.error).finally(() => prisma.$disconnect());
