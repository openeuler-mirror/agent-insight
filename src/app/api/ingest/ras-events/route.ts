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

import { createHash } from 'node:crypto';
import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { ingestCoreRas, deleteCoreRas, analyticsFailure } from '@/lib/storage-core/analytics';
import { handleCoreRasGet } from '@/lib/storage-core/ras';
import { compatibilityFailure } from '@/lib/storage-core/compat';


import { NextResponse } from "next/server"

import { resolveUser } from "@/lib/auth/auth"
import { normalizeRasIngestBody } from "@/lib/ingest/ras/normalize"
import {
  deleteReliabilityTraces,
  findRootExecutionId,
  listAllTasksWithRasEvents,
  listReliabilityTraces,
  listRasEventsByTaskIds,
  summarizeRasByTaskIds,
  upsertRasIngestRecords,
} from "@/lib/ingest/ras/store"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  try {
    {
      const normalized = normalizeRasIngestBody(await req.json());
      if (!normalized.ok) return NextResponse.json({error: normalized.error}, {status: 400});
      const events = (normalized.records || [normalized.record]).map(record => ({...record, ts: record.ts.toISOString(), platform: record.framework, id: 'ras_' + createHash('sha256').update(JSON.stringify([record.taskId,record.deliveryId])).digest('hex')}));
      const result = await ingestCoreRas(req, events);
      return NextResponse.json({status: 'ok', written: result.accepted, ids: result.ids});
    }
  } catch (err: unknown) {
    return compatibilityFailure(err);
  }
}

export async function GET(req: Request) {
  try {
    return await handleCoreRasGet(req);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return analyticsFailure(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const core=isStorageCoreEnabled()
    const user=(true)
    if (!user) {
      return NextResponse.json(
        { error: "unauthorized", detail: "valid x-witty-api-key required" },
        { status: 401 },
      )
    }

    const body = await req.json().catch(() => null)
    const rawTaskIds = Array.isArray(body?.taskIds)
      ? body.taskIds
      : body?.taskId
        ? [body.taskId]
        : []
    const taskIds = rawTaskIds
      .map((id: unknown) => String(id || "").trim())
      .filter(Boolean)
      .slice(0, 200)

    if (!taskIds.length) {
      return NextResponse.json(
        { error: "missing taskIds", detail: "body.taskIds (string[]) required" },
        { status: 400 },
      )
    }

    const result = (await deleteCoreRas(req,taskIds))
    return NextResponse.json({ status: "ok", ...result })
  } catch (err: unknown) {
    return analyticsFailure(err)
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-witty-api-key",
    },
  })
}
