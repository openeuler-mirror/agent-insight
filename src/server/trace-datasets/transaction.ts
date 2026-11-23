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

import type { PrismaClient, Prisma } from '@prisma/client';
// SQLite has a single writer: P1008 (lock past busy_timeout), P2028 (abandoned transaction) and P2034 (write conflict) are transient.
const TRANSIENT = ['P1008', 'P2028', 'P2034'];
export function isTransient(error: unknown) { return TRANSIENT.includes((error as { code?: string } | null)?.code || ''); }
export async function retryTransient<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}
export async function transaction<T>(db: PrismaClient, callback: (tx: Prisma.TransactionClient) => Promise<T>, options = { maxWait: 30000, timeout: 30000 }): Promise<T> {
  return retryTransient(() => db.$transaction(callback, options));
}
