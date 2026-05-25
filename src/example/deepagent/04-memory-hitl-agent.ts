/**
 * Example 4: 持久化对话（MemorySaver + thread_id）与人工审批（interruptOn / HITL）
 *
 * - checkpointer: MemorySaver —— 同一 thread_id 下多轮调用可继承 LangGraph state（含 messages）
 * - interruptOn: 指定工具（此处 write_file）在执行前暂停，等待 Human-in-the-loop 决策
 *
 * 运行（仓库根目录）：
 *   cp src/example/deepagent/.env.example .env   # 若尚无根目录 .env，可复制一份到仓库根或本目录
 *   pnpm deepagent:ex4
 */

import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepSeekModel, streamDeepAgentUntilDone } from "./shared";

async function main() {
  const threadId = `hitl-thread-${Date.now()}`;
  const checkpointer = new MemorySaver();

  const agent = createDeepAgent({
    model: createDeepSeekModel(),
    checkpointer,
    interruptOn: {
      write_file: {
        allowedDecisions: ["approve", "reject"],
        description:
          "即将写入虚拟文件系统（write_file）。确认后再执行；本示例脚本会自动批准。",
      },
    },
    systemPrompt:
      "你是助手。当用户要求写入文件时，你必须调用 write_file，路径使用 /workspace/ 前缀。",
  });

  const baseOpts = {
    configurable: { thread_id: threadId },
  };

  console.log("\n========== 第一轮：触发 write_file → HITL 中断 → 自动批准 ==========");
  console.log("---------- 流式输出 ----------");
  const afterFirst = await streamDeepAgentUntilDone(
    agent,
    {
      messages: [
        {
          role: "user",
          content:
            "请用 write_file 在 /workspace/note.txt 写入一行中文：持久化对话示例。",
        },
      ],
    },
    baseOpts,
  );

  console.log("\n---------- 第一轮结束：最后一条 AI 消息 ----------");
  const msgs1 = afterFirst.messages as { content?: unknown }[];
  console.log(msgs1[msgs1.length - 1]?.content);

  console.log("\n========== 第二轮：同一 thread_id，验证对话记忆 ==========");
  console.log("---------- 流式输出 ----------");
  const afterSecond = await streamDeepAgentUntilDone(
    agent,
    {
      messages: [
        {
          role: "user",
          content: "我刚才让你在哪个路径写了文件？文件里那一行中文是什么？请简短回答。",
        },
      ],
    },
    baseOpts,
  );

  console.log("\n---------- 第二轮结束 ----------");
  const msgs2 = afterSecond.messages as { content?: unknown }[];
  console.log(msgs2[msgs2.length - 1]?.content);

  console.log("\n========== 虚拟文件系统中的 note.txt ==========");
  const files = afterSecond.files ?? {};
  const note = files["/workspace/note.txt"] ?? files["note.txt"];
  if (note) {
    const raw = (note as { content?: unknown }).content;
    const text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
    console.log(text);
  } else {
    console.log("(未找到 note.txt，可能被模型写到其它路径，可在 files 键中自查)");
    console.log(Object.keys(files));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
