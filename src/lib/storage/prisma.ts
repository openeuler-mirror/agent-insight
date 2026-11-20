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

import { loadAgentInsightEnv } from '@/lib/env';
import { controlClient } from '@/lib/storage-core/control-repository';
import { getDatabaseAdapter } from '@/lib/storage/db-interface';
import type { ExtendedPrismaClient } from '@/lib/storage/prisma-client';

loadAgentInsightEnv();

export const prismaRaw = new Proxy({}, {
  get: (_target, key) => controlClient[key],
  set: (_target, key, value) => Reflect.set(controlClient, key, value),
}) as ExtendedPrismaClient;
export const prisma: any = prismaRaw;
export const db = getDatabaseAdapter();
