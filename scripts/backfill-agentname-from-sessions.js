const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--limit") {
      const value = argv[i + 1];
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --limit value: ${value}`);
      args.limit = Math.floor(n);
      i += 1;
      continue;
    }
    throw new Error(`Unknown arg: ${token}`);
  }

  return args;
}

function pickAgentNameFromInteractions(interactionsJson) {
  if (!interactionsJson) return null;
  const interactions = JSON.parse(interactionsJson);
  if (!Array.isArray(interactions)) return null;

  for (const interaction of interactions) {
    if (interaction && typeof interaction.agent === "string" && interaction.agent.trim()) {
      return interaction.agent.trim();
    }
  }

  return null;
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));

  const sessions = await prisma.session.findMany({
    where: { interactions: { not: null } },
    select: { taskId: true, interactions: true },
    ...(limit ? { take: limit } : {}),
  });

  let sessionsWithAgent = 0;
  let executionsUpdated = 0;

  for (const session of sessions) {
    let agentName = null;
    try {
      agentName = pickAgentNameFromInteractions(session.interactions);
    } catch {
      agentName = null;
    }

    if (!agentName) continue;
    sessionsWithAgent += 1;

    if (dryRun) continue;
    const res = await prisma.execution.updateMany({
      where: { taskId: session.taskId },
      data: { agentName },
    });
    executionsUpdated += res.count;
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        sessionsScanned: sessions.length,
        sessionsWithAgent,
        executionsUpdated,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
