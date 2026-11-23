/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const token of argv) {
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    throw new Error(`Unknown arg: ${token}`);
  }
  return args;
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const agents = await prisma.registeredAgent.findMany({
    select: { id: true, name: true },
  });

  let trimmed = 0;
  for (const agent of agents) {
    const nextName = typeof agent.name === "string" ? agent.name.trim() : agent.name;
    if (nextName === agent.name) continue;

    trimmed += 1;
    if (dryRun) continue;

    await prisma.registeredAgent.update({
      where: { id: agent.id },
      data: { name: nextName },
    });
  }

  console.log(JSON.stringify({ dryRun, agentsScanned: agents.length, trimmed }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
