const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const e = await prisma.session.findUnique({ where: { taskId: "ses_2036ce9f6ffedHXYVxH173USQq" } });
  console.log("Interactions count:", e?.interactions ? JSON.parse(e.interactions).length : 0);
  if (e?.interactions) {
    const inters = JSON.parse(e.interactions);
    console.log("First inter agent:", inters[0].agent);
    console.log("First inter role:", inters[0].role);
    console.log("Keys:", Object.keys(inters[0]));
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
