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
