import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { Serialized } from "@langchain/core/load/serializable";
import { LLMResult } from "@langchain/core/outputs";
import { ChainValues } from "@langchain/core/utils/types";
import { CallbackHandler } from "@langfuse/langchain";
import { saveExecutionRecord, ExecutionRecord } from "../../storage/data-service";
import { createLogger } from "@/lib/logger";
import { config } from "./config";
import { langfuseSpanProcessor } from "./instrumentation";

const logger = createLogger("skill-generation:callback");

interface RunContext {
  runId: string;
  parentRunId?: string;
  name: string;
  startTime: number;
  type: "llm" | "chain" | "tool";
  input?: any;
  metadata?: Record<string, any>;
}

function createLangfuseHandler(sessionId?: string) {
  if (!config.langfuse.enabled) return null;

  // Ensure process.env has the cleaned values for the internal SDK to use
  process.env.LANGFUSE_PUBLIC_KEY = config.langfuse.publicKey;
  process.env.LANGFUSE_SECRET_KEY = config.langfuse.secretKey;
  process.env.LANGFUSE_BASE_URL = config.langfuse.baseUrl;

  return new CallbackHandler({
    sessionId: sessionId ?? `skill-gen-${Date.now()}`,
  });
}

/**
 * Callback4AgentInsight Adapter
 * 
 * This adapter captures LangChain/LangGraph execution events and saves them to the database.
 * Inspired by Langfuse's CallbackHandler.
 */
export class Callback4AgentInsight extends BaseCallbackHandler {
  name = "callback4agentinsight";
  private runMap: Map<string, RunContext> = new Map();
  private interactions: any[] = [];
  private rootRunId?: string;
  private taskQuery?: string;
  private langfuseHandler: CallbackHandler | null;
  private langfuseSessionId: string;

  constructor(sessionId?: string) {
    super();
    this.langfuseSessionId = sessionId ?? `skill-gen-${Date.now()}`;
    this.langfuseHandler = createLangfuseHandler(this.langfuseSessionId);
  }

  getLangfuseHandler(): CallbackHandler | null {
    return this.langfuseHandler;
  }

  async handleChainStart(
    chain: Serialized,
    inputs: ChainValues,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, any>
  ): Promise<void> {
    const name = chain.id[chain.id.length - 1];
    logger.debug("Chain start", { runId, parentRunId, name, metadata });
    this.runMap.set(runId, {
      runId,
      parentRunId,
      name,
      startTime: Date.now(),
      type: "chain",
      input: inputs,
      metadata,
    });

    if (!parentRunId) {
      this.rootRunId = runId;
      // Assume the first chain input contains the query
      this.taskQuery = inputs.query || inputs.input || (inputs.messages ? inputs.messages[0]?.content : undefined);
    }
  }

  async handleChainEnd(
    outputs: ChainValues,
    runId: string
  ): Promise<void> {
    const context = this.runMap.get(runId);
    if (!context) return;

    const duration = Date.now() - context.startTime;
    logger.debug("Chain end", { runId, name: context.name, duration });

    if (runId === this.rootRunId) {
      // Final result for the whole task
      const finalResult = outputs.output || outputs.result || JSON.stringify(outputs);
      
      const record: ExecutionRecord = {
        task_id: this.rootRunId,
        query: this.taskQuery,
        latency: duration,
        final_result: finalResult,
        interactions: this.interactions,
        framework: "langgraph", // Defaulting to langgraph for skill-generation
        timestamp: new Date(context.startTime),
      };

      await saveExecutionRecord(record);
      logger.log("Saved root execution record", {
        taskId: this.rootRunId,
        interactionCount: this.interactions.length,
        duration,
      });
    }

    this.runMap.delete(runId);
  }

  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, any>,
    _tags?: string[],
    metadata?: Record<string, any>
  ): Promise<void> {
    const name = llm.id[llm.id.length - 1];
    logger.debug("LLM start", {
      runId,
      parentRunId,
      name,
      promptCount: prompts.length,
      metadata,
    });
    this.runMap.set(runId, {
      runId,
      parentRunId,
      name,
      startTime: Date.now(),
      type: "llm",
      input: prompts,
      metadata,
    });

    // Keep prompt-level logs for detailed troubleshooting.
    prompts.forEach((prompt, i) => {
      logger.debug("LLM prompt", { runId, name, promptIndex: i, prompt });
    });
  }

  async handleLLMEnd(
    output: LLMResult,
    runId: string
  ): Promise<void> {
    const context = this.runMap.get(runId);
    if (!context) return;

    const duration = Date.now() - context.startTime;
    const generation = output.generations[0][0];
    const text = generation.text;
    const usage = output.llmOutput?.tokenUsage || {};
    logger.debug("LLM end", {
      runId,
      name: context.name,
      duration,
      outputPreview: text.slice(0, 500),
      usage,
    });

    this.interactions.push({
      role: "assistant",
      content: text,
      timestamp: Date.now(),
      usage: {
        total: usage.totalTokens,
        input: usage.promptTokens,
        output: usage.completionTokens,
      },
      timeInfo: {
        created: context.startTime,
        completed: Date.now(),
      },
      agent: context.name,
    });

    this.runMap.delete(runId);
  }

  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, any>
  ): Promise<void> {
    const name = tool.id[tool.id.length - 1];
    logger.debug("Tool start", { runId, parentRunId, name, input, metadata });
    this.runMap.set(runId, {
      runId,
      parentRunId,
      name,
      startTime: Date.now(),
      type: "tool",
      input,
      metadata,
    });

  }

  async handleToolEnd(
    output: string,
    runId: string
  ): Promise<void> {
    const context = this.runMap.get(runId);
    if (!context) return;

    const duration = Date.now() - context.startTime;
    logger.debug("Tool end", {
      runId,
      name: context.name,
      duration,
      outputPreview: output.slice(0, 500),
    });

    this.interactions.push({
      role: "tool",
      content: output,
      timestamp: Date.now(),
      timeInfo: {
        created: context.startTime,
        completed: Date.now(),
      },
      tool_calls: [
        {
          name: context.name,
          arguments: context.input,
          output: output,
          timing: {
            started_at: context.startTime,
            completed_at: Date.now(),
          },
        }
      ],
    });

    this.runMap.delete(runId);
  }

  async handleLLMError(err: any, runId: string): Promise<void> {
    logger.error("LLM error", {
      runId,
      error: err?.message || String(err),
    });
    this.runMap.delete(runId);
  }

  async handleChainError(err: any, runId: string): Promise<void> {
    logger.error("Chain error", {
      runId,
      error: err?.message || String(err),
    });
    if (runId === this.rootRunId) {
        const context = this.runMap.get(runId);
        if (context) {
            await saveExecutionRecord({
                task_id: this.rootRunId,
                query: this.taskQuery,
                latency: Date.now() - context.startTime,
                final_result: `Error: ${err.message || String(err)}`,
                interactions: this.interactions,
                framework: "langgraph",
                timestamp: new Date(context.startTime),
                failures: [{
                    failure_type: "CHAIN_ERROR",
                    description: err.message || String(err),
                    context: JSON.stringify(context.input),
                    recovery: "Check agent logs and configuration"
                }]
            });
        }
    }
    this.runMap.delete(runId);
  }

  async handleToolError(err: any, runId: string): Promise<void> {
    logger.error("Tool error", {
      runId,
      error: err?.message || String(err),
    });
    this.runMap.delete(runId);
  }
}
