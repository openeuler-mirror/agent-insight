/**
 * Example 2: 使用 Skills 的 deep agent
 *
 * Skills 是 Anthropic 提出的"渐进式信息披露"模式：
 *   - 每个 skill 是一个目录，里面必须有一个 SKILL.md (含 YAML frontmatter)
 *   - 默认情况下 agent 只会看到 SKILL.md 的 name + description (轻量、省 token)
 *   - 当 agent 判断该 skill 与用户请求相关时，才会读取完整的 SKILL.md 并按里面的指令执行
 *
 * 本例演示两种 skill 加载方式：
 *   A. 从远端 URL 拉一个官方 skill (langgraph-docs) 写入虚拟文件系统
 *   B. 在代码里直接定义一个本地自定义 skill (code-reviewer) 写入虚拟文件系统
 *
 * 运行前置：
 *   pnpm add deepagents @langchain/anthropic @langchain/langgraph
 *   cp .env.example .env
 *
 * 运行（仓库根目录）：
 *   pnpm deepagent:ex2
 */

import { createDeepAgent, type FileData } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepSeekModel, streamDeepAgentUntilDone } from "./shared";

// 工具函数：把字符串内容包成 deepagents 文件系统能识别的 FileData 结构
function createFileData(content: string): FileData {
  const now = new Date().toISOString();
  return {
    content: content.split("\n"),
    created_at: now,
    modified_at: now,
  };
}

async function main() {
  // ========== 1) 准备 skill 文件 ==========
  const skillsFiles: Record<string, FileData> = {};

  // --- A. 远端 skill: 直接 fetch 官方 langgraph-docs SKILL.md ---
  const remoteSkillUrl =
    "https://raw.githubusercontent.com/langchain-ai/deepagentsjs/refs/heads/main/examples/skills/langgraph-docs/SKILL.md";
  const remoteRes = await fetch(remoteSkillUrl);
  if (!remoteRes.ok) {
    throw new Error(`无法拉取远端 skill: ${remoteRes.status}`);
  }
  const remoteSkillContent = await remoteRes.text();
  skillsFiles["/skills/langgraph-docs/SKILL.md"] = createFileData(
    remoteSkillContent,
  );

  // --- B. 本地自定义 skill: 一个简易的"代码审查"技能 ---
  // SKILL.md 必须包含 YAML frontmatter (name + description)，
  // description 写得越精确，agent 越能挑对场景去触发它。
  const codeReviewSkill = `---
name: code-reviewer
description: 当用户请求审查 TypeScript / JavaScript 代码片段、排查潜在 bug、或者要求按"安全/性能/可读性"维度提建议时使用本技能。
---

# code-reviewer

## Overview

按结构化清单审查 JS/TS 代码，输出可执行、可落地的修改建议。

## Instructions

收到代码后，按以下步骤进行：

### 1. 整体阅读
先用 1-2 句话概括这段代码"想做什么"。

### 2. 按四个维度逐项检查
对每个维度独立列出问题（没有就写"无明显问题"）：

- **正确性 (Correctness)**: 边界条件、空值、异步竞态、错误处理是否覆盖？
- **安全性 (Security)**: 是否有注入风险、敏感信息泄漏、不受信输入未校验？
- **性能 (Performance)**: 有无 O(n²) 嵌套、重复 IO、可缓存可批处理的地方？
- **可读性 (Readability)**: 命名、函数职责、注释、类型标注是否清晰？

### 3. 输出修改后的代码
将审查结论写入 \`review.md\` 文件，包含：
- 原代码块
- 问题列表（按维度分组）
- 修改后的完整代码块
- 一段总结性评语 (≤ 80 字)
`;
  skillsFiles["/skills/code-reviewer/SKILL.md"] =
    createFileData(codeReviewSkill);

  // ========== 2) 创建带 skills 的 agent ==========
  const checkpointer = new MemorySaver();

  const agent = createDeepAgent({
    model: createDeepSeekModel(),
    checkpointer,
    // 关键: 告诉 agent 去 "/skills/" 这个虚拟目录下扫描所有 SKILL.md
    // deepagents 会读 frontmatter 并把 skill 列表暴露给 LLM
    skills: ["/skills/"],
  });

  // ========== 3) 运行测试 ==========
  const config = {
    configurable: { thread_id: `thread-${Date.now()}` },
  };

  // 测试 1: 触发 langgraph-docs skill
  console.log("\n========== 测试 1: 询问 LangGraph (应触发 langgraph-docs skill) ==========");
  console.log("---------- 流式输出 ----------");
  const result1 = await streamDeepAgentUntilDone(
    agent,
    {
      messages: [{ role: "user", content: "什么是 LangGraph？它和普通的 LangChain 有什么区别？" }],
      files: skillsFiles,
    },
    config,
  );
  const msgs1 = result1.messages as { content?: unknown }[];
  console.log("\n---------- 最终回复（同上已流式打印）----------");
  console.log(msgs1[msgs1.length - 1]?.content);

  // 测试 2: 触发 code-reviewer skill
  console.log("\n========== 测试 2: 提交代码片段 (应触发 code-reviewer skill) ==========");
  console.log("---------- 流式输出 ----------");
  const result2 = await streamDeepAgentUntilDone(
    agent,
    {
      messages: [
        {
          role: "user",
          content: `帮我审查下面这段 TypeScript 代码：

\`\`\`ts
async function fetchUsers(ids: number[]) {
  const users = [];
  for (const id of ids) {
    const res = await fetch("https://api.example.com/users/" + id);
    users.push(await res.json());
  }
  return users;
}
\`\`\``,
        },
      ],
      files: skillsFiles,
    },
    { configurable: { thread_id: `thread-${Date.now()}-2` } },
  );
  const msgs2 = result2.messages as { content?: unknown }[];
  console.log("\n---------- 最终回复 ----------");
  console.log(msgs2[msgs2.length - 1]?.content);

  // 看看 agent 写出的 review.md
  const reviewFile = (result2.files ?? {})["review.md"];
  if (reviewFile) {
    console.log("\n--- review.md 内容 ---");
    const content = Array.isArray((reviewFile as any).content)
      ? (reviewFile as any).content.join("\n")
      : (reviewFile as any).content;
    console.log(content);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
