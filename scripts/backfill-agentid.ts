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

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting Execution agentId backfill...');

  // Find all Executions that have an agentName but no agentId
  const executions = await prisma.execution.findMany({
    where: {
      agentName: { not: null },
      agentId: null
    }
  });

  console.log(`Found ${executions.length} execution records to update.`);

  let updatedCount = 0;

  for (const exec of executions) {
    if (!exec.agentName || !exec.framework) {
      continue;
    }

    const platform = exec.framework;
    const name = exec.agentName;
    const user = exec.user || null;

    try {
      // Find existing agent
      let agent = await prisma.registeredAgent.findFirst({
        where: {
          platform,
          name,
          user
        }
      });

      // If not found, create a new 'unregistered' agent
      if (!agent) {
        // Find if this execution had an agentType, otherwise default to 'main'
        const agentTypeToUse = (exec as any).agentType || 'main';
        
        agent = await prisma.registeredAgent.create({
          data: {
            platform,
            name,
            user,
            agentOwnership: 'unregistered',
            agentType: agentTypeToUse
          }
        });
        console.log(`Created new unregistered agent: ${name} (${platform}) for user ${user} with type ${agentTypeToUse}`);
      }

      // Update the execution record with the agentId
      await prisma.execution.update({
        where: { id: exec.id },
        data: { agentId: agent.id }
      });
      
      updatedCount++;
    } catch (e) {
      console.error(`Failed to process execution ${exec.id}:`, e);
    }
  }

  console.log(`Finished! Successfully updated ${updatedCount} execution records.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
