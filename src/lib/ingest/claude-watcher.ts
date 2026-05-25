import chokidar from 'chokidar';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeParser } from '@/lib/engine/observability/claude-parser';
import { saveExecutionRecord } from '@/lib/storage/data-service';
import { db } from '@/lib/storage/prisma';

export class ClaudeLogWatcher {
  private parser: ClaudeParser;
  private watchTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private evalTimeouts: Map<string, NodeJS.Timeout> = new Map();
  
  // Quick flush to DB just to see text/tokens (No LLM judging)
  private syncDebounceMs = 3000;
  
  // Wait longer after last token generated before triggering deep LLM Judgment 
  // If the user hasn't generated anything for 30 seconds, the turn is considered done.
  private evalDebounceMs = 30000;
  
  private isStarted = false;

  constructor() {
    this.parser = new ClaudeParser();
  }

  public start() {
    if (this.isStarted) return;
    this.isStarted = true;

    const baseDir = path.join(os.homedir(), '.claude', 'projects');
    
    console.log(`[ClaudeWatcher] Starting to monitor Claude Code logs at: ${baseDir}`);
    // Watch the entire projects directory instead of using globbing (which fails on Mac fsevents sometimes)
    const watcher = chokidar.watch(baseDir, {
      persistent: true,
      ignoreInitial: true
    });

    watcher
      .on('add', (filePath) => {
        if (filePath.endsWith('.jsonl')) this.scheduleParse(filePath, 'add');
      })
      .on('change', (filePath) => {
        if (filePath.endsWith('.jsonl')) this.scheduleParse(filePath, 'change');
      })
      .on('error', error => console.error(`[ClaudeWatcher] Watcher error: ${error}`));
  }

  private scheduleParse(filePath: string, eventName: string) {
    // 1. Clear existing timeouts
    if (this.watchTimeouts.has(filePath)) {
      clearTimeout(this.watchTimeouts.get(filePath)!);
    }
    if (this.evalTimeouts.has(filePath)) {
      clearTimeout(this.evalTimeouts.get(filePath)!);
    }

    // 2. Schedule UI Sync (Fast, no evaluation)
    const syncTimeout = setTimeout(async () => {
      this.watchTimeouts.delete(filePath);
      await this.processLogFile(filePath, eventName, { skip_evaluation: true });
    }, this.syncDebounceMs);
    this.watchTimeouts.set(filePath, syncTimeout);

    // 3. Schedule Deep Evaluation (Slow, assumes session turn is completely finalized)
    const evalTimeout = setTimeout(async () => {
      this.evalTimeouts.delete(filePath);
      console.log(`[ClaudeWatcher] Session idle for ${this.evalDebounceMs / 1000}s, triggering final Evaluation for: ${filePath}`);
      await this.processLogFile(filePath, 'evaluation_timeout', { skip_evaluation: false, force_judgment: true });
    }, this.evalDebounceMs);
    this.evalTimeouts.set(filePath, evalTimeout);
  }

  private async getSkillInsightUserFromEnv(): Promise<string | undefined> {
    try {
      const envPath = path.join(os.homedir(), '.skill-insight', '.env');
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const match = content.match(/SKILL_INSIGHT_API_KEY=(.*)/);
        if (match && match[1]) {
          const apiKey = match[1].trim();
          const user = await db.findUserByApiKey(apiKey);
          if (user) return user.username;
        }
      }
    } catch (e) {
      console.error('[ClaudeWatcher] Error reading skill-insight env:', e);
    }
    return undefined;
  }

  private async processLogFile(filePath: string, eventName: string, options: { skip_evaluation: boolean; force_judgment?: boolean }) {
    try {
      const record = await this.parser.parseFile(filePath);

      if (record && record.task_id) {
        if (!record.query || !record.final_result) return;
        
        const envUser = await this.getSkillInsightUserFromEnv();
        
        await saveExecutionRecord({
            user: envUser, // Pass matching user explicitly
            ...record,
            ...options
        } as any);
        console.log(`[ClaudeWatcher] Upserted session ${record.task_id} for user ${envUser || 'unknown'} (skip_eval: ${options.skip_evaluation})`);
      }
    } catch (err) {
      console.error(`[ClaudeWatcher] Failed to process log file ${filePath}:`, err);
    }
  }
}

// Singleton instance to be used across the Next.js app
export const claudeWatcher = new ClaudeLogWatcher();
