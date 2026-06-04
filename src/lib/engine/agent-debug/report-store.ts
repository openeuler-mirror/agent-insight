import crypto from 'node:crypto';

import { prismaRaw } from '@/lib/storage/prisma';
import type { AgentDebugReportPayload, AgentDebugReportRow, AgentDebugSkillsAnalysis } from './types';

export async function ensureAgentDebugReportTable() {
  await prismaRaw.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AgentDebugReport" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "executionId" TEXT NOT NULL UNIQUE,
      "user" TEXT,
      "interactionsHash" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "errorMessage" TEXT,
      "reportJson" TEXT,
      "stepCount" INTEGER NOT NULL DEFAULT 0,
      "issueCount" INTEGER NOT NULL DEFAULT 0,
      "llmCallCount" INTEGER NOT NULL DEFAULT 0,
      "durationMs" INTEGER,
      "generator" TEXT NOT NULL DEFAULT 'agent-debug-diagnosis-skill@0.1',
      "ranAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prismaRaw.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentDebugReport_user_ranAt_idx" ON "AgentDebugReport" ("user", "ranAt")`);
  await prismaRaw.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentDebugReport_status_idx" ON "AgentDebugReport" ("status")`);
}

export async function findAgentDebugReport(executionId: string): Promise<AgentDebugReportRow | null> {
  await ensureAgentDebugReportTable();
  const rows = await prismaRaw.$queryRawUnsafe<AgentDebugReportRow[]>(
    `SELECT * FROM "AgentDebugReport" WHERE "executionId" = ? LIMIT 1`,
    executionId,
  );
  return rows[0] || null;
}

export async function upsertRunningAgentDebugReport(args: {
  executionId: string;
  user?: string | null;
  interactionsHash: string;
}): Promise<AgentDebugReportRow> {
  await ensureAgentDebugReportTable();
  const existing = await findAgentDebugReport(args.executionId);
  const now = new Date().toISOString();
  if (existing) {
    await prismaRaw.$executeRawUnsafe(
      `UPDATE "AgentDebugReport"
       SET "user" = ?, "interactionsHash" = ?, "status" = 'running', "errorMessage" = NULL, "updatedAt" = ?
       WHERE "executionId" = ?`,
      args.user ?? null,
      args.interactionsHash,
      now,
      args.executionId,
    );
  } else {
    await prismaRaw.$executeRawUnsafe(
      `INSERT INTO "AgentDebugReport" ("id", "executionId", "user", "interactionsHash", "status", "ranAt", "updatedAt")
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      crypto.randomUUID(),
      args.executionId,
      args.user ?? null,
      args.interactionsHash,
      now,
      now,
    );
  }
  const row = await findAgentDebugReport(args.executionId);
  if (!row) throw new Error('failed to create AgentDebugReport');
  return row;
}

export async function markAgentDebugReportDone(args: {
  executionId: string;
  report: AgentDebugReportPayload;
}) {
  const now = new Date().toISOString();
  await prismaRaw.$executeRawUnsafe(
    `UPDATE "AgentDebugReport"
     SET "status" = 'done',
         "errorMessage" = NULL,
         "reportJson" = ?,
         "stepCount" = ?,
         "issueCount" = ?,
         "llmCallCount" = ?,
         "durationMs" = ?,
         "generator" = ?,
         "updatedAt" = ?
     WHERE "executionId" = ?`,
    JSON.stringify(args.report),
    args.report.stats.stepCount,
    args.report.stats.issueCount,
    args.report.stats.llmCallCount,
    args.report.stats.durationMs,
    args.report.generator,
    now,
    args.executionId,
  );
  return findAgentDebugReport(args.executionId);
}

export async function markAgentDebugReportFailed(args: {
  executionId: string;
  errorMessage: string;
}) {
  await ensureAgentDebugReportTable();
  await prismaRaw.$executeRawUnsafe(
    `UPDATE "AgentDebugReport"
     SET "status" = 'failed', "errorMessage" = ?, "updatedAt" = ?
     WHERE "executionId" = ?`,
    args.errorMessage,
    new Date().toISOString(),
    args.executionId,
  );
  return findAgentDebugReport(args.executionId);
}

export async function deleteAgentDebugReport(executionId: string) {
  await ensureAgentDebugReportTable();
  await prismaRaw.$executeRawUnsafe(`DELETE FROM "AgentDebugReport" WHERE "executionId" = ?`, executionId);
}

export async function updateAgentDebugSkillsAnalysis(args: {
  executionId: string;
  skillsAnalysis: AgentDebugSkillsAnalysis;
}) {
  await ensureAgentDebugReportTable();
  const row = await findAgentDebugReport(args.executionId);
  const report = parseReportPayload(row);
  if (!report) {
    throw new Error('AgentDebug report is required before generating Skills analysis');
  }
  const next: AgentDebugReportPayload = {
    ...report,
    skillsAnalysis: args.skillsAnalysis,
  };
  await prismaRaw.$executeRawUnsafe(
    `UPDATE "AgentDebugReport"
     SET "reportJson" = ?, "updatedAt" = ?
     WHERE "executionId" = ?`,
    JSON.stringify(next),
    new Date().toISOString(),
    args.executionId,
  );
  return findAgentDebugReport(args.executionId);
}

export function parseReportPayload(row: AgentDebugReportRow | null): AgentDebugReportPayload | null {
  if (!row?.reportJson) return null;
  try {
    return JSON.parse(row.reportJson) as AgentDebugReportPayload;
  } catch {
    return null;
  }
}
