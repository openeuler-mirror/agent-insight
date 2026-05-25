const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const e = await prisma.execution.findUnique({ where: { id: "ses_2036ce9f6ffedHXYVxH173USQq" } });
  console.log(e);
}
main().catch(console.error).finally(() => prisma.$disconnect());
