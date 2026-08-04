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
  extractSkills: extractSkillsWithVersionsFromOpenClawSession,
  normalizeForStorage: (interactions: CanonicalInteraction[]) => {
    if (!Array.isArray(interactions)) return interactions;

    return interactions.map((interaction: any) => {
      if (!interaction || typeof interaction !== "object") return interaction;

      const result = {
        ...interaction,
        tool_calls: Array.isArray(interaction.tool_calls)
          ? interaction.tool_calls.map((call: any) => ({ ...call, function: call?.function ? { ...call.function } : call?.function }))
          : interaction.tool_calls,
      };

      const attrs = result.attributes || {};
      const spanKind = String(attrs["gen_ai.span.kind"] || "").toLowerCase();
      const spanName = (result.name || "").toLowerCase();

      if (spanKind === "agent" || spanKind === "entry" || spanName === "invoke_agent") {
        result.role = result.role || "subagent";
        result.agent = result.agent || attrs["witty.agent.name"] || attrs["gen_ai.agent.name"] || attrs["agent.name"] || result.serviceName || "openclaw-agent";
        result.subagent_type = attrs["agent.type"] || "subagent";
        result.subagent_session_id = attrs["witty.agent.id"] || result.sessionId || attrs["witty.session.id"] || attrs["session.id"];

        if (!Array.isArray(result.tool_calls)) {
          result.tool_calls = [];
        }
        const hasTaskMark = result.tool_calls.some((tc: any) =>
          (tc?.function?.name || tc?.name) === "task"
        );
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

      if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) {
        const flatBlocks = result.tool_calls.map((tc: any) => {
          const rawArguments = tc?.function?.arguments ?? tc?.arguments ?? {};
          const args = typeof rawArguments === "string"
            ? (() => { try { return JSON.parse(rawArguments); } catch { return rawArguments; } })()
            : rawArguments;
          return {
            type: "toolCall",
            name: tc?.function?.name || tc?.name || "tool",
            arguments: args,
          };
        });
        const existingContent = Array.isArray(result.responseMessage?.content)
          ? [...result.responseMessage.content]
          : [];
        const signatures = new Set(existingContent
          .filter((block: any) => block?.type === "toolCall")
          .map((block: any) => JSON.stringify({ name: block.name, arguments: block.arguments })));
        for (const block of flatBlocks) {
          const signature = JSON.stringify({ name: block.name, arguments: block.arguments });
          if (signatures.has(signature)) continue;
          signatures.add(signature);
          existingContent.push(block);
        }
        result.responseMessage = {
          ...(result.responseMessage || {}),
          content: existingContent,
        };
      }

      return result;
    });
  },
}
