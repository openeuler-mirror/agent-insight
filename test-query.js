const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const e = await prisma.execution.findMany({ where: { id: { contains: "ses_" } }, take: 5 });
  console.log("Executions:", JSON.stringify(e, null, 2));
  const s = await prisma.session.findMany({ where: { id: { contains: "ses_" } }, take: 5 });
  console.log("Sessions:", JSON.stringify(s, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
