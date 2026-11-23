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

const { PrismaClient } = require('@prisma/client');

async function removeLegacySummary(databaseUrl) {
  if (!databaseUrl?.startsWith('file:')) return false;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    return await db.$transaction(async tx => {
      const columns = await tx.$queryRawUnsafe('PRAGMA table_info("TraceDatasetGenerationJob")');
      if (!columns.some(column => column.name === 'summaryJson')) return false;
      await tx.$executeRawUnsafe('ALTER TABLE "TraceDatasetGenerationJob" DROP COLUMN "summaryJson"');
      return true;
    });
  } finally { await db.$disconnect(); }
}

module.exports = { removeLegacySummary };
if (require.main === module) removeLegacySummary(process.env.DATABASE_URL)
  .then(changed => { if (changed) console.log('Removed legacy Trace dataset summary storage; jobs and datasets preserved.'); })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
