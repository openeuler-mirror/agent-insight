const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const a = await prisma.registeredAgent.findMany();
  console.log("Agents:", JSON.stringify(a, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
