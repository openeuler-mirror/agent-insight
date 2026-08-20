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
    const { username, apiKey } = await resolveUser(req)
    if (apiKey && !username) {
      return NextResponse.json({ error: "unauthorized", detail: "invalid API key" }, { status: 401 })
    }
    if (!username && !process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER) {
      return NextResponse.json(
        {
          error: "unauthorized",
          detail: "x-witty-api-key required (or set AGENT_INSIGHT_DEFAULT_INGEST_USER for local demo)",
        },
        { status: 401 },
      )
    }
    const effectiveUser = username || process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER || null

    const body = await req.json()
    const normalized = normalizeRasIngestBody(body)
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 })
    }
    const records = normalized.records || [normalized.record]
    const result = await upsertRasIngestRecords(records, effectiveUser)
    return NextResponse.json({
      status: "ok",
      written: result.written,
      ids: result.ids,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[RAS ingest] POST error:", message)
    return NextResponse.json({ status: "error", message }, { status: 500 })
  }
}

export async function GET(req: Request) {
  try {
    const { username: user } = await resolveUser(req)
    const url = new URL(req.url)
    const taskId = url.searchParams.get("taskId")
    const taskIdsParam = url.searchParams.get("taskIds")
    const summary = url.searchParams.get("summary") === "1"
    const taskIds = taskIdsParam
      ? taskIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : taskId
        ? [taskId]
        : []

    if (!user) {
      return NextResponse.json(
        { error: "unauthorized", detail: "valid x-witty-api-key required" },
        { status: 401 },
      )
    }

    if (!taskIds.length) {
      if (summary) {
        const traces = await listReliabilityTraces({
          user,
          limit: Math.min(Number(url.searchParams.get("limit") || "200"), 500),
        })
        return NextResponse.json({ status: "ok", traces })
      }
      const recentTaskIds = await listAllTasksWithRasEvents({
        user,
        limit: Number(url.searchParams.get("limit") || "200"),
      })
      if (!recentTaskIds.length) {
        return NextResponse.json({ status: "ok", traces: [] })
      }
      const events = await listRasEventsByTaskIds({ taskIds: recentTaskIds, user, limit: Number(url.searchParams.get("limit") || "200") })
      return NextResponse.json({ status: "ok", events })
    }

    if (summary) {
      const byTask = await summarizeRasByTaskIds({ taskIds, user })
      return NextResponse.json({ status: "ok", byTask })
    }

    const events = await listRasEventsByTaskIds({
      taskIds,
      user,
      limit: Number(url.searchParams.get("limit") || 200),
    })
    const executionId = taskIds.length === 1 ? await findRootExecutionId(taskIds[0]) : null
    return NextResponse.json({ status: "ok", events, executionId })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[RAS ingest] GET error:", message)
    return NextResponse.json({ status: "error", message }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const { username: user } = await resolveUser(req)
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

    const result = await deleteReliabilityTraces({ taskIds, user })
    return NextResponse.json({ status: "ok", ...result })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[RAS ingest] DELETE error:", message)
    return NextResponse.json({ status: "error", message }, { status: 500 })
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
