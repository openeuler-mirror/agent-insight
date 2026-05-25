const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const agents = await prisma.registeredAgent.findMany();
  for (const agent of agents) {
    if (agent.name.startsWith(' ')) {
      await prisma.registeredAgent.update({
        where: { id: agent.id },
        data: { name: agent.name.trim() }
      });
      console.log(`Trimmed name for agent ${agent.id}`);
    }
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
