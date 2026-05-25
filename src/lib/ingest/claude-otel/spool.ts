import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeOtelAppendResult, ClaudeOtelEvent } from './types';

export function getClaudeOtelSpoolDir(): string {
  return process.env.SKILL_INSIGHT_CLAUDE_OTEL_SPOOL_DIR ||
    path.join(os.homedir(), '.skill-insight', 'otel_data', 'claude');
}

function dayString(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function appendJsonl(file: string, rows: any[]): void {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  fs.appendFileSync(file, text, 'utf8');
}

export function appendClaudeOtelEvents(events: ClaudeOtelEvent[], spoolDir = getClaudeOtelSpoolDir()): ClaudeOtelAppendResult {
  const dirtySessionIds = Array.from(new Set(events.map((e) => e.sessionId).filter(Boolean)));
  if (events.length === 0) return { events, dirtySessionIds };
  const file = path.join(spoolDir, dayString(), 'logs.jsonl');
  appendJsonl(file, events);
  return { events, dirtySessionIds };
}

export function listClaudeOtelSpoolFiles(spoolDir = getClaudeOtelSpoolDir()): string[] {
  const out: string[] = [];
  try {
    const days = fs.readdirSync(spoolDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const day of days) {
      const dir = path.join(spoolDir, day.name);
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) out.push(path.join(dir, file));
    }
  } catch {}
  return out.sort();
}

export function readClaudeOtelEventsForSession(sessionId: string, spoolDir = getClaudeOtelSpoolDir()): ClaudeOtelEvent[] {
  const events: ClaudeOtelEvent[] = [];
  for (const file of listClaudeOtelSpoolFiles(spoolDir)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.sessionId === sessionId) events.push(event);
      } catch {}
    }
  }
  return events;
}

