import { createAgent } from "langchain";
import {
  FilesystemBackend,
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createDeepAgent,
  type SubAgent,
  type CompiledSubAgent,
} from "deepagents";
import { createModel } from "@/lib/engine/skill-generation/shared/model";
import { GENERATOR_SYSTEM_PROMPT } from "@/lib/engine/skill-generation/generator/prompts";
import { createFilesystemTools } from "@/lib/engine/skill-generation/generator/tools/files";
import type { GenerationOptions } from "@/lib/engine/skill-generation";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:supervisor");

/**
 * Virtual sub-directory (relative to the sandboxed workspace root) where the
 * generator agent is allowed to write skill files. Because the FilesystemBackend
 * is configured with `virtualMode: true`, the agent only ever sees paths under
 * `/`, and `/skills_generator` maps to `<workspaceRoot>/skills_generator` on disk.
 */
const SKILLS_VIRTUAL_DIR = "/skills_generator";

function buildSupervisorSystemPrompt(workspaceRoot: string) {
  return `
你是技能生成项目（Skill Generation project）的负责人（Supervisor）。你的职责是协调 Agent Skill 的生成工作。

你的目标是根据用户的需求规范（SkillSpec）生成高质量的技能。

工作流：
1. 初始化项目：技能必须写入虚拟路径 \`${SKILLS_VIRTUAL_DIR}/\${spec.name}\`（这对应磁盘上的 \`${workspaceRoot}${SKILLS_VIRTUAL_DIR}/\${spec.name}\`）。
2. 生成/改进：委托 "generator-agent" 来创建或优化技能文件。
3. 决策：根据你自己的检查结果，决定是“迭代（iterate）”（返回第 2 步）还是“接受（accept）”（完成）。
4. 总结：整理并向用户报告最终状态。

文件系统规则（严格执行）：
- 你处于沙箱环境中：每个文件路径都必须以 \`/\` 开头，且保留在工作区内。
- 所有生成的技能文件必须存放在 \`${SKILLS_VIRTUAL_DIR}/<skill-name>/\` 下。
- 绝不要尝试访问 \`..\`、\`~\` 或沙箱外的任何路径 —— 这些调用将会失败。
- 使用文件系统工具（\`ls\`、\`read_file\`、\`write_file\`、\`edit_file\`、\`glob\`、\`grep\`）进行所有文件操作。

约束：
- 使用 "task" 工具将工作委托给子 Agent。
- 在你自己的"思考"中规划步骤；不要使用 todo 工具（本 agent 未启用）。
- 保持关于当前迭代和技能路径的上下文。
- 本次运行的沙箱工作区根目录（宿主路径，仅供参考）：\`${workspaceRoot}\`。

输出格式：
- 如果你的输出包含代码 or JSON 数据，必须使用 Markdown 代码块（例如 \`\`\`json\n...\n\`\`\` 或 \`\`\`python\n...\n\`\`\`）进行格式化，以便前端显示。

语言要求：
- 除非用户明确要求使用其他语言，否则对于所有面向用户的自然语言文本，请使用中文回复。
`.trim();
}

/**
 * Resolve the workspace root for a given session.
 *
 * - If `sessionId` is provided, the workspace is `~/.agent_insight/workspace/{sessionId}`,
 *   which is stable across runs (so the same session keeps its files).
 * - Otherwise we fall back to a freshly minted UUID directory.
 *
 * The `skills_generator/` subdirectory is pre-created so that even an empty
 * `ls /skills_generator` returns successfully.
 */
export function resolveWorkspaceRoot(sessionId?: string): string {
  const id = sessionId && sessionId.length > 0 ? sessionId : randomUUID();
  const workspaceRoot = join(homedir(), ".agent_insight", "workspace", id);
  mkdirSync(join(workspaceRoot, "skills_generator"), { recursive: true });
  return workspaceRoot;
}

export function createSupervisorAgent(options?: GenerationOptions) {
  logger.log("Creating supervisor agent", {
    enableEvaluation: options?.enableEvaluation ?? false,
    workspaceRootInput: options?.workspaceRoot ?? null,
    sessionId: options?.sessionId ?? null,
    modelId: options?.modelId ?? null,
  });

  const model = createModel(options || {});

  // Prefer an explicitly passed workspaceRoot (e.g. for tests), then sessionId,
  // then a one-shot UUID directory.
  const workspaceRoot =
    options?.workspaceRoot || resolveWorkspaceRoot(options?.sessionId);

  // Sandboxed real-disk backend. virtualMode: true means:
  //   - the agent sees `/`, `/skills_generator/...`, etc.
  //   - those map to `<workspaceRoot>/...` on disk
  //   - `..` / `~` traversal is blocked by the backend
  const backend = new FilesystemBackend({
    rootDir: workspaceRoot,
    virtualMode: true,
  });

  // Tools that the generator-agent expects (in addition to the filesystem
  // tools it inherits via FilesystemMiddleware).
  const fsTools = createFilesystemTools(workspaceRoot);

  // Build the generator subagent using `createDeepAgent` so it inherits the
  // full deepagents middleware stack (filesystem + todos + planning helpers).
  // We share the same sandboxed `backend`, so any files the generator writes
  // are immediately visible to the supervisor under the same virtual paths.
  const generatorAgent = createDeepAgent({
    model,
    systemPrompt: GENERATOR_SYSTEM_PROMPT,
    tools: [...fsTools],
    // Pass our sandboxed backend so the deep agent's filesystem middleware
    // operates on the same workspace as the supervisor.
    backend: () => backend,
  });

  const generatorSubagent: CompiledSubAgent = {
    name: "generator-agent",
    description:
      "Generates or improves a skill based on a specification. Writes files to /skills_generator/<skill-name>/.",
    // Mount the pre-built deep agent as a runnable. `createSubAgentMiddleware`
    // will invoke this graph via the `task` tool instead of constructing a
    // plain ReAct agent from `systemPrompt` + `tools`.
    runnable: generatorAgent,
  };

  const subagents: (SubAgent | CompiledSubAgent)[] = [generatorSubagent];

  logger.log("Supervisor agent created", {
    workspaceRoot,
    skillsVirtualDir: SKILLS_VIRTUAL_DIR,
    subagentCount: subagents.length,
  });

  // We use `createAgent` (not `createDeepAgent`) so we have full control over
  // which middleware is attached. Specifically: we deliberately omit
  // `todoListMiddleware` here — the supervisor doesn't need a write_todos tool,
  // and including it adds ~7 extra tool tokens & encourages unnecessary
  // planning detours.
  /**
   * Return the compiled agent.
   * NOTE: Due to the complexity of multi-agent coordination and file operations,
   * callers should increase the recursionLimit (e.g., to 500 or more) when
   * invoking or streaming this agent to avoid GraphRecursionError.
   */
  return createAgent({
    model,
    systemPrompt: buildSupervisorSystemPrompt(workspaceRoot),
    middleware: [
      // Filesystem tools (ls / read_file / write_file / edit_file / glob / grep),
      // backed by our sandboxed FilesystemBackend.
      createFilesystemMiddleware({ backend }),

      // Subagents via the `task` tool. defaultTools=[] means inline subagents
      // (defined by systemPrompt + tools) only get what they declare. Our
      // generator-agent is mounted as a pre-built graph, so this setting has
      // no effect on it.
      createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: [],
        subagents,
      }),

      // No todoListMiddleware — write_todos is intentionally not exposed.
    ],
  });
}