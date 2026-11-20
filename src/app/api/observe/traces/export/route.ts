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

import { NextResponse } from 'next/server';
import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { handleCompatibleTransfer } from '@/lib/storage-core/compat';
import { resolveTraceReadScope } from '@/lib/auth/admin';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { exportTraceBundle } from '@/lib/trace-transfer-service';

export const dynamic = 'force-dynamic';

function safeFileSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'trace';
}
export async function GET(request: Request) {
    return handleCompatibleTransfer(request, 'export');
}
