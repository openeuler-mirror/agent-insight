const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const e = await prisma.session.findUnique({ where: { taskId: "ses_2036ce9f6ffedHXYVxH173USQq" } });
  if (e?.interactions) {
    const inters = JSON.parse(e.interactions);
    const agentNames = new Set();
    inters.forEach(i => { if (i.agent) agentNames.add(i.agent); });
    console.log("Agents:", Array.from(agentNames));
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
