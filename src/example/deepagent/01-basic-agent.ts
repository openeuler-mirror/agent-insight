/**
 * Example 1: 最简单的 deepagents 默认实现
 *
 * 演示 createDeepAgent() 的最小可运行用法：
 *   - 模型来自 .env (默认 deepseek-chat)
 *   - 默认开启: 规划工具 (write_todos)、文件系统 (ls/read_file/write_file/edit_file/glob/grep)、子代理 (task)
 *   - 默认后端: StateBackend (内存中的虚拟文件系统，存在于 LangGraph state 里)
 *
 * 运行前置：
 *   pnpm add deepagents @langchain/anthropic
 *   cp .env.example .env
 *
 * 运行（仓库根目录）：
 *   pnpm deepagent:ex1
 */

import { createDeepAgent } from "deepagents";
import { createDeepSeekModel, streamDeepAgentUntilDone } from "./shared";

async function main() {
  // 1. 创建 deep agent，模型来自 .env（默认 DeepSeek）
  const agent = createDeepAgent({
    model: createDeepSeekModel(),
  });

  console.log("\n========== 模型 token 流式输出 ==========");
  // 2. 异步流式调用 agent
  //    - 用户让它"做研究并写文件"，agent 会自己规划 (write_todos)
  //      然后通过内置的 write_file 把内容存进虚拟文件系统
  const result = await streamDeepAgentUntilDone(
    agent,
    {
      messages: [
        {
          role: "user",
          content:
            "请研究一下 LangGraph 这个框架的核心概念，整理一份简短的中文摘要，保存到 summary.md 文件里。",
        },
      ],
    },
    {},
  );

  // 3. 查看 agent 最终的回复
  const lastMessage = result.messages[result.messages.length - 1];
  console.log("\n========== Agent 最终回复 ==========");
  console.log(lastMessage?.content);

  // 4. 查看虚拟文件系统里 agent 写出的文件
  //    StateBackend 把文件挂在 result.files 上
  console.log("\n========== 虚拟文件系统 ==========");
  const files = result.files ?? {};
  for (const [path, fileData] of Object.entries(files)) {
    console.log(`\n--- 文件: ${path} ---`);
    // FileData.content 是按行存的字符串数组
    const content = Array.isArray((fileData as any).content)
      ? (fileData as any).content.join("\n")
      : (fileData as any).content;
    console.log(content);
  }

  // 5. 看看 agent 用过哪些工具 (规划/文件系统/子代理...都会在这里出现)
  console.log("\n========== 工具调用轨迹 ==========");
  for (const msg of result.messages) {
    const toolCalls = (msg as any).tool_calls;
    if (toolCalls?.length) {
      for (const call of toolCalls) {
        console.log(`-> ${call.name}(${JSON.stringify(call.args).slice(0, 120)}...)`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
