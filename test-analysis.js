const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const e = await prisma.execution.findUnique({ where: { id: "ses_2036ce9f6ffedHXYVxH173USQq" } });
  console.log("Execution Framework:", e?.framework, "Label:", e?.label);
  const a = await prisma.registeredAgent.findFirst({ where: { name: { contains: "Xuanyuan" } } });
  console.log("Agent Platform:", a?.platform, "Name:", a?.name);
}
main().catch(console.error).finally(() => prisma.$disconnect());
