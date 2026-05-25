/**
 * Example 3: 调用 SubAgents 的 deep agent
 *
 * SubAgents 是 deepagents 的核心特性之一，主要解决两个问题：
 *   1. 上下文隔离 (context quarantine):
 *      子代理跑完后只把"结论"返给主代理，主代理的上下文不会被冗长的中间过程污染。
 *   2. 角色专门化 (specialization):
 *      每个子代理可以有自己的 systemPrompt / tools / model / middleware。
 *
 * 调用方式：主代理通过内置的 task 工具，把 (子代理名, 子任务描述) 派发出去。
 *
 * 本例的架构（一个常见的 "supervisor" 模式）：
 *
 *     ┌──────────────────────────┐
 *     │     Main Agent           │  ← 协调者，只做规划和分派
 *     │  (todo + task + fs)      │
 *     └──────┬───────────┬───────┘
 *            │ task      │ task
 *            ▼           ▼
 *     ┌────────────┐  ┌──────────────┐
 *     │ research-  │  │ critique-    │
 *     │ agent      │  │ agent        │
 *     │ (search)   │  │ (无外部工具) │
 *     └────────────┘  └──────────────┘
 *
 * 运行前置：
 *   pnpm add deepagents @langchain/anthropic @langchain/tavily langchain zod
 *   cp .env.example .env
 *   export TAVILY_API_KEY=tvly-...
 *
 * 运行（仓库根目录）：
 *   pnpm deepagent:ex3
 */

import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { createDeepAgent, type SubAgent } from "deepagents";
import { z } from "zod";
import { createDeepSeekModel, streamDeepAgentUntilDone } from "./shared";

// ========== 1) 定义子代理需要的工具 ==========
const internetSearch = tool(
  async ({
    query,
    maxResults = 5,
    topic = "general",
    includeRawContent = false,
  }: {
    query: string;
    maxResults?: number;
    topic?: "general" | "news" | "finance";
    includeRawContent?: boolean;
  }) => {
    if (!process.env.TAVILY_API_KEY) {
      return JSON.stringify({
        note: "未配置 TAVILY_API_KEY，返回离线示例数据以保证示例可独立跑通。",
        query,
        results: [
          {
            title: "LangGraph 趋势（示例）",
            url: "https://github.com/langchain-ai/langgraph",
            content:
              "LangGraph 在 2025 年继续强化多代理编排、检查点恢复、人机协同审批。",
          },
          {
            title: "AutoGen 趋势（示例）",
            url: "https://github.com/microsoft/autogen",
            content:
              "AutoGen 侧重多智能体对话框架，强调角色化协作和可观测执行。",
          },
          {
            title: "CrewAI 趋势（示例）",
            url: "https://github.com/crewAIInc/crewAI",
            content:
              "CrewAI 在任务流编排与角色分工层面持续演进，强调业务流程自动化落地。",
          },
        ],
      });
    }

    const tavilySearch = new TavilySearch({
      maxResults,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      includeRawContent,
      topic,
    });
    return await tavilySearch._call({ query });
  },
  {
    name: "internet_search",
    description: "在互联网上检索一个查询，返回带摘要的结果列表。",
    schema: z.object({
      query: z.string().describe("搜索关键词"),
      maxResults: z.number().optional().default(5),
      topic: z.enum(["general", "news", "finance"]).optional().default("general"),
      includeRawContent: z.boolean().optional().default(false),
    }),
  },
);

// ========== 2) 定义专门化子代理 ==========

// 子代理 A: 研究员 —— 只负责搜资料，把发现写进文件系统
const researchSubagent: SubAgent = {
  name: "research-agent",
  description:
    "调研型子代理。给它一个明确的研究问题，它会做多轮网络搜索并把要点整理到指定文件里。" +
    "调用时请提供：要研究的具体问题 + 要把结果写到哪个文件。",
  systemPrompt: `你是一名严谨的调研员。

工作流程：
1. 分析用户给的研究问题，拆成 2-4 个具体的搜索查询
2. 用 internet_search 工具逐个执行
3. 综合所有结果，写一份"事实+来源"格式的笔记到指定文件 (使用 write_file 工具)
4. 笔记格式: 每个要点一行，行尾用 [source: URL] 标注来源
5. 完成后简短回复"已写入 <文件名>，共 N 条要点"

不要在回复里堆砌长文，正文必须落到文件里。`,
  tools: [internetSearch],
};

// 子代理 B: 评论员 —— 不能上网，只能读主代理已经写好的文件、给出修改意见
const critiqueSubagent: SubAgent = {
  name: "critique-agent",
  description:
    "评审型子代理。它会读取一个已有的 markdown 报告文件，从'事实准确性 / 论证完整性 / 表达清晰度'三个维度提出改进建议。" +
    "调用时请提供：要评审的文件路径。",
  systemPrompt: `你是一名挑剔但建设性的编辑。

工作流程：
1. 用 read_file 工具读取用户指定的文件
2. 从三个维度逐条列出问题（每条 ≤ 1 句）：
   - 事实准确性: 是否有未引用的断言、过时数据、明显错误
   - 论证完整性: 是否漏掉了反方观点、关键背景、必要前提
   - 表达清晰度: 是否有冗长、术语滥用、结构混乱
3. 把建议写入 critique.md (使用 write_file)
4. 简短回复"评审完成，共发现 N 条建议"

不要重写报告本身，只产出建议清单。`,
  // 注意: 这里没有给它 internetSearch，强制它只能基于文件内容做评审
};

// ========== 3) 创建主代理 ==========
const agent = createDeepAgent({
  model: createDeepSeekModel(),
  // 主代理也保留搜索工具，便于做最终的事实校验
  tools: [internetSearch],
  subagents: [researchSubagent, critiqueSubagent],
  systemPrompt: `你是一个研究项目的总协调者。

你的工作流程必须如下：
1. 先用 write_todos 制定一个清晰的 TODO 列表
2. 把"调研"任务通过 task 工具派给 research-agent，让它把笔记写到 research-notes.md
3. 读取 research-notes.md，基于笔记起草一份正式报告 report.md (用 write_file)
4. 把"评审报告"任务通过 task 工具派给 critique-agent，让它评审 report.md
5. 读取 critique.md，根据建议用 edit_file 修订 report.md
6. 最后简短汇报：报告路径 + 主要发现 (3 条) + 修订了哪些点

重要约束：
- 不要自己直接做调研，调研一律交给 research-agent (上下文隔离)
- 不要自己评审自己写的报告，评审交给 critique-agent (避免自我确认偏差)`,
});

// ========== 4) 运行（异步流式） ==========
async function main() {
  console.log("\n========== 主代理回答（流式 token） ==========");
  const result = await streamDeepAgentUntilDone(
    agent,
    {
      messages: [
        {
          role: "user",
          content:
            "请帮我研究一下 2025 年 AI Agent 框架的主要趋势（focus 在 LangGraph、AutoGen、CrewAI 这几家），" +
            "产出一份 3-5 段的中文摘要报告。",
        },
      ],
    },
    {},
  );

  // ========== 5) 输出结果 ==========
  console.log("\n========== 主代理最终回复（摘要） ==========");
  console.log((result.messages as { content?: unknown }[])[result.messages.length - 1]?.content);

  console.log("\n========== 工作流轨迹 (只看 task 派发) ==========");
  for (const msg of result.messages) {
    const toolCalls = (msg as any).tool_calls;
    if (toolCalls?.length) {
      for (const call of toolCalls) {
        if (call.name === "task") {
          console.log(`\n-> 派发给子代理 "${call.args.subagent_type}":`);
          console.log(`   ${String(call.args.description ?? "").slice(0, 200)}...`);
        } else if (call.name === "write_todos") {
          console.log(`\n-> 更新 TODO 列表`);
        }
      }
    }
  }

  console.log("\n========== 虚拟文件系统产物 ==========");
  for (const [path, fileData] of Object.entries(result.files ?? {})) {
    const content = Array.isArray((fileData as any).content)
      ? (fileData as any).content.join("\n")
      : (fileData as any).content;
    console.log(`\n--- ${path} (${content.length} 字符) ---`);
    console.log(content.slice(0, 500) + (content.length > 500 ? "\n..." : ""));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
