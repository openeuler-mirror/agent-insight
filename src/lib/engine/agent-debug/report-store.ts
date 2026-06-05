import crypto from 'node:crypto';

import { prismaRaw } from '@/lib/storage/prisma';
import type {
  AgentDebugReportPayload,
  AgentDebugReportRow,
  AgentDebugSkillsAnalysis,
  AgentDebugSkillsAnalysisRow,
} from './types';

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

export async function ensureAgentDebugSkillsAnalysisTable() {
  await prismaRaw.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AgentDebugSkillsAnalysis" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "executionId" TEXT NOT NULL UNIQUE,
      "user" TEXT,
      "interactionsHash" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "errorMessage" TEXT,
      "analysisJson" TEXT,
      "keyActionCount" INTEGER NOT NULL DEFAULT 0,
      "ranAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prismaRaw.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentDebugSkillsAnalysis_user_ranAt_idx" ON "AgentDebugSkillsAnalysis" ("user", "ranAt")`);
  await prismaRaw.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentDebugSkillsAnalysis_status_idx" ON "AgentDebugSkillsAnalysis" ("status")`);
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
       SET "user" = ?,
           "interactionsHash" = ?,
           "status" = 'running',
           "errorMessage" = NULL,
           "reportJson" = NULL,
           "stepCount" = 0,
           "issueCount" = 0,
           "llmCallCount" = 0,
           "durationMs" = NULL,
           "updatedAt" = ?
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
  interactionsHash?: string;
}) {
  const now = new Date().toISOString();
  const report = stripEmbeddedSkillsAnalysis(args.report);
  const values = [
    JSON.stringify(report),
    report.stats.stepCount,
    report.stats.issueCount,
    report.stats.llmCallCount,
    report.stats.durationMs,
    report.generator,
    now,
    args.executionId,
  ];
  if (args.interactionsHash) values.push(args.interactionsHash);
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
      WHERE "executionId" = ?${args.interactionsHash ? ` AND "interactionsHash" = ? AND "status" = 'running'` : ''}`,
    ...values,
  );
  return findAgentDebugReport(args.executionId);
}

export async function markAgentDebugReportFailed(args: {
  executionId: string;
  errorMessage: string;
  interactionsHash?: string;
}) {
  await ensureAgentDebugReportTable();
  const values = [args.errorMessage, new Date().toISOString(), args.executionId];
  if (args.interactionsHash) values.push(args.interactionsHash);
  await prismaRaw.$executeRawUnsafe(
    `UPDATE "AgentDebugReport"
      SET "status" = 'failed',
          "errorMessage" = ?,
          "reportJson" = NULL,
          "stepCount" = 0,
          "issueCount" = 0,
          "llmCallCount" = 0,
          "durationMs" = NULL,
          "updatedAt" = ?
      WHERE "executionId" = ?${args.interactionsHash ? ` AND "interactionsHash" = ? AND "status" = 'running'` : ''}`,
    ...values,
  );
  return findAgentDebugReport(args.executionId);
}

export async function deleteAgentDebugReport(executionId: string) {
  await ensureAgentDebugReportTable();
  await deleteAgentDebugSkillsAnalysis(executionId);
  await prismaRaw.$executeRawUnsafe(`DELETE FROM "AgentDebugReport" WHERE "executionId" = ?`, executionId);
}

export async function findAgentDebugSkillsAnalysis(executionId: string): Promise<AgentDebugSkillsAnalysisRow | null> {
  await ensureAgentDebugSkillsAnalysisTable();
  const rows = await prismaRaw.$queryRawUnsafe<AgentDebugSkillsAnalysisRow[]>(
    `SELECT * FROM "AgentDebugSkillsAnalysis" WHERE "executionId" = ? LIMIT 1`,
    executionId,
  );
  return rows[0] || null;
}

export async function upsertAgentDebugSkillsAnalysis(args: {
  executionId: string;
  user?: string | null;
  interactionsHash: string;
  skillsAnalysis: AgentDebugSkillsAnalysis;
}): Promise<AgentDebugSkillsAnalysisRow> {
  await ensureAgentDebugSkillsAnalysisTable();
  const existing = await findAgentDebugSkillsAnalysis(args.executionId);
  const now = new Date().toISOString();
  const keyActionCount = Array.isArray(args.skillsAnalysis.keyActionResults)
    ? args.skillsAnalysis.keyActionResults.length
    : 0;
  if (existing) {
    await prismaRaw.$executeRawUnsafe(
      `UPDATE "AgentDebugSkillsAnalysis"
       SET "user" = ?,
           "interactionsHash" = ?,
           "status" = ?,
           "errorMessage" = ?,
           "analysisJson" = ?,
           "keyActionCount" = ?,
           "updatedAt" = ?
       WHERE "executionId" = ?`,
      args.user ?? null,
      args.interactionsHash,
      args.skillsAnalysis.status,
      args.skillsAnalysis.errorMessage ?? null,
      JSON.stringify(args.skillsAnalysis),
      keyActionCount,
      now,
      args.executionId,
    );
  } else {
    await prismaRaw.$executeRawUnsafe(
      `INSERT INTO "AgentDebugSkillsAnalysis"
       ("id", "executionId", "user", "interactionsHash", "status", "errorMessage", "analysisJson", "keyActionCount", "ranAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      args.executionId,
      args.user ?? null,
      args.interactionsHash,
      args.skillsAnalysis.status,
      args.skillsAnalysis.errorMessage ?? null,
      JSON.stringify(args.skillsAnalysis),
      keyActionCount,
      now,
      now,
    );
  }
  const row = await findAgentDebugSkillsAnalysis(args.executionId);
  if (!row) throw new Error('failed to save AgentDebugSkillsAnalysis');
  return row;
}

export async function updateRunningAgentDebugSkillsAnalysis(args: {
  executionId: string;
  user?: string | null;
  interactionsHash: string;
  skillsAnalysis: AgentDebugSkillsAnalysis;
}): Promise<AgentDebugSkillsAnalysisRow | null> {
  await ensureAgentDebugSkillsAnalysisTable();
  const now = new Date().toISOString();
  const keyActionCount = Array.isArray(args.skillsAnalysis.keyActionResults)
    ? args.skillsAnalysis.keyActionResults.length
    : 0;
  await prismaRaw.$executeRawUnsafe(
    `UPDATE "AgentDebugSkillsAnalysis"
      SET "user" = ?,
          "status" = ?,
          "errorMessage" = ?,
          "analysisJson" = ?,
          "keyActionCount" = ?,
          "updatedAt" = ?
      WHERE "executionId" = ? AND "interactionsHash" = ? AND "status" = 'running'`,
    args.user ?? null,
    args.skillsAnalysis.status,
    args.skillsAnalysis.errorMessage ?? null,
    JSON.stringify(args.skillsAnalysis),
    keyActionCount,
    now,
    args.executionId,
    args.interactionsHash,
  );
  return findAgentDebugSkillsAnalysis(args.executionId);
}

export async function deleteAgentDebugSkillsAnalysis(executionId: string) {
  await ensureAgentDebugSkillsAnalysisTable();
  await prismaRaw.$executeRawUnsafe(`DELETE FROM "AgentDebugSkillsAnalysis" WHERE "executionId" = ?`, executionId);
}

export function parseReportPayload(row: AgentDebugReportRow | null): AgentDebugReportPayload | null {
  if (!row?.reportJson) return null;
  try {
    return stripEmbeddedSkillsAnalysis(JSON.parse(row.reportJson) as AgentDebugReportPayload);
  } catch {
    return null;
  }
}

export function parseSkillsAnalysisPayload(row: AgentDebugSkillsAnalysisRow | null): AgentDebugSkillsAnalysis | null {
  if (!row?.analysisJson) return null;
  try {
    return JSON.parse(row.analysisJson) as AgentDebugSkillsAnalysis;
  } catch {
    return null;
  }
}

function stripEmbeddedSkillsAnalysis(report: AgentDebugReportPayload): AgentDebugReportPayload {
  const { skillsAnalysis: _skillsAnalysis, ...rest } = report;
  return rest as AgentDebugReportPayload;
}
