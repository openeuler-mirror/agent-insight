import fs from 'fs';
import readline from 'readline';

/**
 * Parses Claude Code session `.jsonl` files and transforms them into an ExecutionRecord.
 */
export interface ClaudeExecutionRecord {
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
  tool_call_count: number;
  llm_call_count: number;
  input_tokens: number;
  output_tokens: number;
  tool_call_error_count: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  max_single_call_tokens: number;
  reasoning_tokens: number;
}

export class ClaudeParser {
  /**
   * Parse a single `.jsonl` log file from Claude Code.
   */
  async parseFile(filePath: string): Promise<ClaudeExecutionRecord | null> {
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
       if (!entry.message) continue;

       // A new real user prompt starts a new turn
       if (entry.type === 'user' && !entry.message.content?.some?.((c: any) => c.type === 'tool_result')) {
           if (currentTurn.length > 0) turns.push(currentTurn);
           currentTurn = [entry];
       } else {
           if (currentTurn.length > 0) currentTurn.push(entry);
       }
    }
    if (currentTurn.length > 0) turns.push(currentTurn);

    let sessionId = entries[0].sessionId || "";
    let firstUserMsg = "";
    let lastAssistantMsg = "";
    let model = "";
    const cwd = entries.find(e => e.cwd)?.cwd || "";
    let totalTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadInputTokens = 0;
    let totalCacheCreationInputTokens = 0;
    let llmCallCount = 0;
    let toolCallErrorCount = 0;
    let totalActiveLatencyMs = 0;
    let maxSingleCallTokens = 0;
    let totalReasoningTokens = 0;
    const skills = new Set<string>();
    const interactions: any[] = [];

    // Map to track tool calls and their results
    const toolCallMap = new Map<string, any>();
    
    for (const turn of turns) {
        let turnStartTime = 0;
        let turnEndTime = 0;
        
        for (const entry of turn) {
            const ts = new Date(entry.timestamp).getTime();
            if (ts && !isNaN(ts)) {
                if (!turnStartTime || ts < turnStartTime) turnStartTime = ts;
                if (!turnEndTime || ts > turnEndTime) turnEndTime = ts;
            }

            interactions.push({ type: entry.type, message: entry.message, timestamp: entry.timestamp });

            if (entry.type === 'user' && !firstUserMsg && !entry.isMeta) {
                let rawText = "";
                if (typeof entry.message.content === 'string') {
                    rawText = entry.message.content;
                } else if (Array.isArray(entry.message.content)) {
                    const textBlock = entry.message.content.find((c: any) => c.type === 'text');
                    if (textBlock) rawText = textBlock.text;
                }

                if (rawText && !rawText.includes('<local-command-caveat>') && !rawText.includes('<local-command-stdout>')) {
                    const cmdMsgMatch = rawText.match(/<command-message>([\s\S]*?)<\/command-message>/);
                    if (cmdMsgMatch) {
                        const cmd = cmdMsgMatch[1].trim(); 
                        if (cmd !== 'clear' && cmd !== 'compact') firstUserMsg = cmd;
                    } else {
                        const cmdNameMatch = rawText.match(/<command-name>\/?([^<]+)<\/command-name>/);
                        // If the text is purely the command name wrapper
                        if (cmdNameMatch && !rawText.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim()) {
                            const cmd = cmdNameMatch[1].trim();
                            if (cmd !== 'clear' && cmd !== 'compact') firstUserMsg = cmd;
                        } else {
                            firstUserMsg = rawText;
                        }
                    }
                    if (firstUserMsg) {
                        sessionId = entry.sessionId || sessionId;
                    }
                }
            }

            if (entry.type === 'assistant') {
                llmCallCount++;
                if (entry.message.model) model = entry.message.model;
                if (entry.message.usage) {
                    const baseToks = entry.message.usage.input_tokens || 0;
                    const cacheReadToks = entry.message.usage.cache_read_input_tokens || 0;
                    const cacheCreateToks = entry.message.usage.cache_creation_input_tokens || 0;
                    const outToks = entry.message.usage.output_tokens || 0;
                    const reasoningToks = entry.message.usage.reasoning_tokens || 0;
                    totalInputTokens += baseToks;  // base input only (excludes cache)
                    totalOutputTokens += outToks;
                    totalReasoningTokens += reasoningToks;
                    const callTotal = baseToks + cacheReadToks + cacheCreateToks + outToks;
                    totalTokens += callTotal;
                    totalCacheReadInputTokens += cacheReadToks;
                    totalCacheCreationInputTokens += cacheCreateToks;
                    if (callTotal > maxSingleCallTokens) maxSingleCallTokens = callTotal;
                }

                if (Array.isArray(entry.message.content)) {
                    const textBlock = entry.message.content.filter((c: any) => c.type === 'text').pop();
                    if (textBlock && textBlock.text) {
                        lastAssistantMsg = textBlock.text;
                    }
                    const toolBlocks = entry.message.content.filter((c: any) => c.type === 'tool_use');
                    for (const tool of toolBlocks) {
                        // Store tool call for later matching with result
                        if (tool.id) {
                            toolCallMap.set(tool.id, {
                                name: tool.name,
                                input: tool.input,
                                timestamp: entry.timestamp
                            });
                        }
                        
                        // Handle native Claude Code "Skill" system integration invocation
                        if (tool.name === 'Skill' && tool.input && typeof tool.input.skill === 'string') {
                            skills.add(tool.input.skill.trim());
                        } 
                        // If it's another non-built-in tool (custom Witty tools or other custom MCPs not starting with uppercase)
                        else if (tool.name && !/^[A-Z]/.test(tool.name)) {
                            skills.add(tool.name);
                        }
                    }
                }
            }
            
            // Count tool call errors from tool_result content blocks
            if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
                for (const block of entry.message.content) {
                    if (block.type === 'tool_result' && block.is_error) {
                        toolCallErrorCount++;
                    }
                }
            }

            // Process tool results and add timing information
            if (entry.toolUseResult && entry.toolUseResult.durationMs) {
                const toolUseId = entry.toolUseID;
                if (toolUseId && toolCallMap.has(toolUseId)) {
                    const toolCall = toolCallMap.get(toolUseId);
                    // Find the interaction with this tool call and add timing
                    const interaction = interactions.find((i: any) => 
                        i.type === 'assistant' && 
                        Array.isArray(i.message?.content) &&
                        i.message.content.some((c: any) => c.type === 'tool_use' && c.id === toolUseId)
                    );
                    
                    if (interaction) {
                        const toolUse = interaction.message.content.find((c: any) => c.type === 'tool_use' && c.id === toolUseId);
                        if (toolUse) {
                            toolUse.timing = {
                                started_at: toolCall.timestamp,
                                completed_at: entry.timestamp,
                                duration_ms: entry.toolUseResult.durationMs
                            };
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
      framework: 'claudecode',
      tokens: totalTokens,
      latency: totalActiveLatencyMs,
      timestamp: new Date().toISOString(),
      final_result: lastAssistantMsg || "[No final text output]",
      model: model,
      skills: Array.from(skills),
      interactions: interactions,
      cwd: cwd,
      tool_call_count: toolCallMap.size,
      llm_call_count: llmCallCount,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      tool_call_error_count: toolCallErrorCount,
      cache_read_input_tokens: totalCacheReadInputTokens,
      cache_creation_input_tokens: totalCacheCreationInputTokens,
      max_single_call_tokens: maxSingleCallTokens,
      reasoning_tokens: totalReasoningTokens
    };
  }
}
