import chokidar from 'chokidar';
import os from 'os';
import path from 'path';
import { OpenClawParser } from '@/lib/engine/observability/openclaw-parser';
import { saveExecutionRecord } from '@/lib/storage/data-service';

export class OpenClawLogWatcher {
  private parser: OpenClawParser;
  private watchTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private evalTimeouts: Map<string, NodeJS.Timeout> = new Map();
  
  // Quick flush to DB just to see text/tokens (No LLM judging)
  private syncDebounceMs = 3000;
  
  // Wait longer after last token generated before triggering deep LLM Judgment 
  // If the user hasn't generated anything for 30 seconds, the turn is considered done.
  private evalDebounceMs = 30000;
  
  private isStarted = false;

  constructor() {
    this.parser = new OpenClawParser();
  }

  public start() {
    if (this.isStarted) return;
    this.isStarted = true;

    const baseDir = path.join(os.homedir(), '.openclaw', 'agents');
    
    console.log(`[OpenClawWatcher] Starting to monitor OpenClaw logs at: ${baseDir}`);
    
    // Watch the entire agents directory
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
      .on('error', error => console.error(`[OpenClawWatcher] Watcher error: ${error}`));
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
      console.log(`[OpenClawWatcher] Session idle for ${this.evalDebounceMs / 1000}s, triggering final Evaluation for: ${filePath}`);
      await this.processLogFile(filePath, 'evaluation_timeout', { skip_evaluation: false, force_judgment: true });
    }, this.evalDebounceMs);
    this.evalTimeouts.set(filePath, evalTimeout);
  }

  private async processLogFile(filePath: string, eventName: string, options: { skip_evaluation: boolean; force_judgment?: boolean }) {
    try {
      const record = await this.parser.parseFile(filePath);

      if (record && record.task_id) {
        if (!record.query || !record.final_result) return;
        
        await saveExecutionRecord({
            ...record,
            ...options
        } as any);
        console.log(`[OpenClawWatcher] Upserted session ${record.task_id} (skip_eval: ${options.skip_evaluation})`);
      }
    } catch (err) {
      console.error(`[OpenClawWatcher] Failed to process log file ${filePath}:`, err);
    }
  }
}

// Singleton instance to be used across the Next.js app
export const openclawWatcher = new OpenClawLogWatcher();
