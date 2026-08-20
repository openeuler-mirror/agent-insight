/** Display labels for Agent RAS / observe platform (framework) codes. */
export function getPlatformLabel(platform?: string | null): string {
  const value = String(platform || "").trim();
  if (!value) return "—";
  switch (value.toLowerCase()) {
    case "langfuse-langgraph":
      return "Langfuse-Langgraph";
    case "opencode":
      return "OpenCode";
    case "openjiuwen":
    case "jiuwen":
      return "openJiuwen";
    case "claude":
    case "claudecode":
      return "Claude Code";
    case "hermes":
      return "Hermes";
    case "openclaw":
      return "OpenClaw";
    case "xiaoo":
      return "xiaoO";
    default:
      return value;
  }
}

/** Prefer RAS event platform, then execution framework. */
export function resolveTracePlatform(opts: {
  eventPlatform?: string | null;
  eventFramework?: string | null;
  executionFramework?: string | null;
}): string | null {
  const raw =
    String(opts.eventPlatform || "").trim()
    || String(opts.eventFramework || "").trim()
    || String(opts.executionFramework || "").trim();
  return raw || null;
}
