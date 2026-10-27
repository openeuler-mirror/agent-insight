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

import type { Prisma } from '@prisma/client';
import type { AnomalyStatus } from '@/lib/reliability/anomaly-status';
import { selectExecutionListPage } from './execution-list-sql';

export interface ComputedRecordPageOptions {
    status: string;
    anomaly: AnomalyStatus | 'all';
    sortKey: 'timestamp' | 'agentName' | 'latency' | 'tokens' | 'cost' | 'status';
    sortDir: 'asc' | 'desc';
    page: number;
    pageSize: number;
    lifecycleNow?: number;
}

export async function selectComputedRecordPage(where: Prisma.ExecutionWhereInput, options: ComputedRecordPageOptions) {
    return selectExecutionListPage(where, options);
}
