import fs from 'fs';
import readline from 'readline';

/**
 * Parses OpenClaw session `.jsonl` files and transforms them into an ExecutionRecord.
 */
export interface OpenClawExecutionRecord {
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

export class OpenClawParser {
  /**
   * Parse a single `.jsonl` log file from OpenClaw.
   */
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
