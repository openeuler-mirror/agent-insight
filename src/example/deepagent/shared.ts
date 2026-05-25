import "dotenv/config";
import { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { Command } from "@langchain/langgraph";
import { INTERRUPT, isInterrupted } from "@langchain/langgraph";
import type { HITLRequest, HITLResponse } from "langchain";

export function createDeepSeekModel() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not set");
  }
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

  return new ChatOpenAI({
    apiKey,
    model,
    configuration: {
      baseURL,
    },
  });
}

function chunkText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as AIMessageChunk;
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part !== null && "text" in part
            ? String((part as { text?: string }).text ?? "")
            : "",
      )
      .join("");
  }
  return "";
}

type StreamableAgent = {
  stream: (
    input: unknown,
    options?: Record<string, unknown>,
  ) => Promise<AsyncIterable<unknown>>;
};

/**
 * 异步流式执行：同时订阅 messages（token/chunk 输出）与 values（完整状态）。
 */
export async function streamDeepAgentRun(
  agent: StreamableAgent,
  input: unknown,
  streamOpts: Record<string, unknown>,
  options?: { printTokens?: boolean },
): Promise<{ state: Record<string, unknown> | null }> {
  const printTokens = options?.printTokens !== false;
  const stream = await agent.stream(input, {
    ...streamOpts,
    streamMode: ["messages", "values"],
    recursionLimit: 500, // Increased limit for complex deep agents
  });

  let latestValues: Record<string, unknown> | null = null;

  for await (const chunk of stream) {
    if (!Array.isArray(chunk)) continue;
    const mode = chunk[0];
    const payload = chunk[1];

    if (mode === "values") {
      latestValues = payload as Record<string, unknown>;
      continue;
    }

    if (mode === "messages" && printTokens) {
      const tuple = payload as [unknown, unknown];
      const msg = tuple?.[0];
      if (AIMessageChunk.isInstance(msg as BaseMessage)) {
        const text = chunkText(msg);
        if (text) process.stdout.write(text);
      }
    }
  }

  if (printTokens) process.stdout.write("\n");
  return { state: latestValues };
}

/**
 * 流式执行并在命中 HITL（interruptOn）时用 Command 恢复；默认自动批准全部待审动作。
 */
export async function streamDeepAgentUntilDone(
  agent: StreamableAgent,
  initialInput: unknown,
  streamOpts: Record<string, unknown> = {},
  options?: { printTokens?: boolean },
): Promise<Record<string, unknown>> {
  let input: unknown = initialInput;

  while (true) {
    const { state } = await streamDeepAgentRun(agent, input, streamOpts, options);
    if (!state) {
      throw new Error("Agent stream 未返回 values 状态。");
    }

    if (!isInterrupted(state)) {
      return state;
    }

    const interrupts = state[INTERRUPT] as Array<{ value: HITLRequest }>;

    console.log("\n========== HITL：工具执行已暂停，等待审批 ==========");
    for (const intr of interrupts) {
      console.log(JSON.stringify(intr.value.actionRequests, null, 2));
    }

    const resume: HITLResponse = {
      decisions: interrupts.flatMap((intr) =>
        intr.value.actionRequests.map(() => ({ type: "approve" as const })),
      ),
    };

    console.log("（示例）自动批准并 resume …\n");
    input = new Command({ resume });
  }
}
