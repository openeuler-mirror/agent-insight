import { extractSkillsWithVersionsFromOpenClawSession } from "@/lib/shared/interaction-utils"
import type { CanonicalInteraction, FrameworkAdapter } from "./types"

export const openclawAdapter: FrameworkAdapter = {
  descriptor: {
    id: "openclaw",
    aliases: ["openclaw-gateway", "openclaw-agent"],
    label: "OpenClaw",
    onboard: "plugin",
    platform: "openclaw",
  },
  capabilities: { ownSkillsFromTree: false },
  extractSkills: extractSkillsWithVersionsFromOpenClawSession,
  normalizeForStorage: (interactions: CanonicalInteraction[]) => {
    if (!Array.isArray(interactions)) return interactions;

    return interactions.map((interaction: any) => {
      if (!interaction || typeof interaction !== "object") return interaction;

      const result = { ...interaction };

      // ── 形状A: 扁平 toolCall 块（skill 抽取链路） ──
      // 聚合器产出的嵌套 tool_calls[{id, type:'function', function:{name, arguments}}]
      // → 扁平 { type:'toolCall', name, arguments } 置入 responseMessage.content[]
      if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) {
        const flatBlocks = result.tool_calls.map((tc: any) => ({
          type: "toolCall",
          name: tc?.function?.name || tc?.name || "tool",
          arguments: typeof tc?.function?.arguments === "string"
            ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })()
            : tc?.function?.arguments || tc?.arguments || {},
        }));

        // 合并到现有 content
        const existingContent = Array.isArray(result.responseMessage?.content)
          ? result.responseMessage.content
          : [];
        result.responseMessage = {
          ...(result.responseMessage || {}),
          content: [...existingContent, ...flatBlocks],
        };
      }

      // ── 形状B: opencode 同构 agent 标记（建树/派生/注册链路） ──
      // agent 边界（gen_ai.span.kind=AGENT 或 invoke_agent span）
      // → tool_calls[name='task'], subagent_type, subagent_session_id, role, agent
      const attrs = result.attributes || {};
      const spanKind = attrs["gen_ai.span.kind"];
      const spanName = (result.name || "").toLowerCase();

      if (spanKind === "agent" || spanKind === "entry" || spanName === "invoke_agent") {
        // 该 interaction 是一个 agent 边界
        result.role = result.role || "subagent";
        result.agent = result.agent || attrs["gen_ai.agent.name"] || attrs["agent.name"] || result.serviceName || "openclaw-agent";

        // subagent 标识
        result.subagent_type = attrs["agent.type"] || "subagent";
        result.subagent_session_id = result.sessionId || attrs["session.id"];

        // 添加 opencode 同构的 task spawn 标记（用于 buildAgentCallTree）
        if (!Array.isArray(result.tool_calls)) {
          result.tool_calls = [];
        }
        const hasTaskMark = result.tool_calls.some((tc: any) => tc?.name === "task");
        if (!hasTaskMark) {
          result.tool_calls.push({
            name: "task",
            arguments: {
              subagent_type: result.subagent_type,
              subagent_session_id: result.subagent_session_id,
            },
          });
        }
      }

      return result;
    });
  },
}
