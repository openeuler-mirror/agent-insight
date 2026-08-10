import chokidar from 'chokidar';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import http from 'http';
import https from 'https';
import { URL } from 'url';

// ============================================================================
// OpenClaw Parser - Directly copied from src/lib/openclaw-parser.ts
// ============================================================================

interface OpenClawExecutionRecord {
  task_id: string;
  query: string;
  framework: string;
  tokens: number;
  latency: number;
  timestamp: string;
  final_result: string;
  model: string;
  skills: string[];
  interactions: any[];
  cwd?: string;
}

class OpenClawParser {
  async parseFile(filePath: string): Promise<OpenClawExecutionRecord | null> {
    if (!fs.existsSync(filePath)) return null;

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    const entries: any[] = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch (e) {
        // syntax error for the JSON line, ignore safely
      }
    }
    
    if (entries.length === 0) return null;
    
    // Group into sub-tasks (turns) to accurately calculate active latency
    const turns: any[][] = [];
    let currentTurn: any[] = [];
    
    for (const entry of entries) {
       if (entry.type !== 'message') continue;

       // A new real user prompt starts a new turn
       if (entry.message?.role === 'user' && !this.isToolResult(entry.message)) {
           if (currentTurn.length > 0) turns.push(currentTurn);
           currentTurn = [entry];
       } else {
           if (currentTurn.length > 0) currentTurn.push(entry);
       }
    }
    if (currentTurn.length > 0) turns.push(currentTurn);

    let sessionId = "";
    let firstUserMsg = "";
    let lastAssistantMsg = "";
    let model = "";
    let cwd = "";
    let totalTokens = 0;
    let totalActiveLatencyMs = 0;
    const skills = new Set<string>();
    const interactions: any[] = [];

    // Extract session info
    const sessionEntry = entries.find(e => e.type === 'session');
    if (sessionEntry) {
        sessionId = sessionEntry.id || "";
        cwd = sessionEntry.cwd || "";
    }

    // Extract model info
    const modelEntry = entries.find(e => e.type === 'model_change');
    if (modelEntry) {
        model = `${modelEntry.provider}/${modelEntry.modelId}`;
    }

    for (const turn of turns) {
        let turnStartTime = 0;
        let turnEndTime = 0;
        
        for (let i = 0; i < turn.length; i++) {
            const entry = turn[i];
            const ts = new Date(entry.timestamp).getTime();
            if (ts && !isNaN(ts)) {
                if (!turnStartTime || ts < turnStartTime) turnStartTime = ts;
                if (!turnEndTime || ts > turnEndTime) turnEndTime = ts;
            }

            const interaction: any = { type: entry.message?.role, message: entry.message, timestamp: entry.timestamp };
            
            if (entry.message?.role === 'assistant') {
                const nextEntry = turn[i + 1];
                let latency = 0;
                
                if (nextEntry) {
                    const nextTs = new Date(nextEntry.timestamp).getTime();
                    if (nextTs && !isNaN(nextTs) && ts && !isNaN(ts)) {
                        latency = nextTs - ts;
                    }
                }
                
                interaction.latency = latency;
            }
            
            interactions.push(interaction);

            if (entry.message?.role === 'user' && !firstUserMsg) {
                const rawText = this.extractTextFromMessage(entry.message);
                
                if (rawText && !this.isSystemMessage(rawText)) {
                    firstUserMsg = this.extractUserQuery(rawText);
                }
            }

            if (entry.message?.role === 'assistant') {
                if (entry.message.model) {
                    const provider = entry.message.provider || 'unknown';
                    model = `${provider}/${entry.message.model}`;
                }

                if (entry.message.usage) {
                    totalTokens += (entry.message.usage.totalTokens || 0);
                }

                if (Array.isArray(entry.message.content)) {
                    const textBlock = entry.message.content.filter((c: any) => c.type === 'text').pop();
                    if (textBlock && textBlock.text) {
                        lastAssistantMsg = textBlock.text;
                    }
                    
                    const toolBlocks = entry.message.content.filter((c: any) => c.type === 'toolCall');
                    for (const tool of toolBlocks) {
                        if (tool.name) {
                            skills.add(tool.name);
                        }
                    }
                }
            }
        }
        
        if (turnEndTime > turnStartTime) {
            totalActiveLatencyMs += (turnEndTime - turnStartTime);
        }
    }

    if (!sessionId) return null;

    return {
      task_id: sessionId,
      query: firstUserMsg,
      framework: 'openclaw',
      tokens: totalTokens,
      latency: totalActiveLatencyMs,
      timestamp: new Date().toISOString(),
      final_result: lastAssistantMsg || "[No final text output]",
      model: model,
      skills: Array.from(skills),
      interactions: interactions,
      cwd: cwd
    };
  }

  private extractTextFromMessage(message: any): string {
    if (!message?.content) return "";
    
    if (typeof message.content === 'string') {
        return message.content;
    }
    
    if (Array.isArray(message.content)) {
        const textBlock = message.content.find((c: any) => c.type === 'text');
        if (textBlock?.text) {
            return textBlock.text;
        }
    }
    
    return "";
  }

  private isToolResult(message: any): boolean {
    return message?.role === 'toolResult';
  }

  private isSystemMessage(text: string): boolean {
    // Filter out system startup messages
    const systemPatterns = [
        /A new session was started/,
        /^\[.*GMT\+\d+\]$/  // Time-only lines
    ];
    
    return systemPatterns.some(pattern => pattern.test(text));
  }

  private extractUserQuery(text: string): string {
    // Remove Sender metadata if present
    const senderPattern = /Sender \(untrusted metadata\):[\s\S]*?\n\n\[.*GMT\+\d+\]\s*(.+)/;
    const senderMatch = text.match(senderPattern);
    if (senderMatch) {
        return senderMatch[1].trim();
    }
    
    // Return original text if no metadata pattern found
    return text.trim();
  }
}

// ============================================================================
// HTTP Upload (replaces saveExecutionRecord)
// ============================================================================

function loadSkillInsightConfig(): { apiKey: string; host: string } {
    const config: { apiKey: string; host: string } = { apiKey: '', host: '' };
    try {
        for (const envPath of [path.join(os.homedir(), '.agent-insight', '.env'), path.join(os.homedir(), '.skill-insight', '.env')]) {
            if (!fs.existsSync(envPath)) continue;
            const content = fs.readFileSync(envPath, 'utf-8');
            const apiKeyMatch = content.match(/AGENT_INSIGHT_API_KEY=(.*)/);
            const hostMatch = content.match(/AGENT_INSIGHT_HOST=(.*)/);
            if (apiKeyMatch && apiKeyMatch[1]) {
                config.apiKey = apiKeyMatch[1].trim();
            }
            if (hostMatch && hostMatch[1]) {
                config.host = hostMatch[1].trim();
            }
        }
    } catch (e) {
        console.error('[OpenClawWatcher] Error reading agent-insight config:', e);
    }
    return config;
}

async function uploadExecutionRecord(record: any): Promise<void> {
    const config = loadSkillInsightConfig();
    if (!config.apiKey || !config.host) {
        console.error('[OpenClawWatcher] Missing API key or host in config');
        return;
    }

    let urlStr = config.host;
    if (!urlStr.match(/^https?:\/\//)) {
        urlStr = `http://${urlStr}`;
    }
    
    const parsedUrl = new URL(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;
    
    const body = JSON.stringify(record);
    
    const basePath = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname;
    
    const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: `${basePath}/api/ingest/upload`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-witty-api-key': config.apiKey
        }
    };

    return new Promise((resolve) => {
        const req = requestModule.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`[OpenClawWatcher] Upload success: ${res.statusCode}`);
                } else {
                    console.error(`[OpenClawWatcher] Upload failed: ${res.statusCode}, ${data}`);
                }
                resolve();
            });
        });
        req.on('error', (e) => {
            console.error(`[OpenClawWatcher] Upload error: ${e.message}`);
            resolve();
        });
        req.setTimeout(10000, () => {
            console.error('[OpenClawWatcher] Upload timeout');
            req.destroy();
            resolve();
        });
        req.end(body);
    });
}

// ============================================================================
// OpenClaw Watcher - Based on src/lib/openclaw-watcher.ts
// ============================================================================

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
        
        await uploadExecutionRecord({
            ...record,
            ...options
        });
        console.log(`[OpenClawWatcher] Uploaded session ${record.task_id} (skip_eval: ${options.skip_evaluation})`);
      }
    } catch (err) {
      console.error(`[OpenClawWatcher] Failed to process log file ${filePath}:`, err);
    }
  }
}

// Start the watcher
const watcher = new OpenClawLogWatcher();
watcher.start();

console.log('[OpenClawWatcher] OpenClaw Watcher Client started');
