import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Agent, setGlobalDispatcher } from "undici";

import { ensureOpencodeServer, stopOpencodeServer, getServerUrl } from "./opencode-manager.js";
import { AgentInsight, type SendPromptPayload } from "./opencode-client.js";

// 关键:扩大 undici 连接池上限。
// 每个并发的 event.subscribe() 会占一条长连接,默认 connections 上限较低,
// 多 session 并发时会和普通 HTTP 请求互相饿死(kimaki 踩过这个坑)。
setGlobalDispatcher(new Agent({ connections: 64 }));

// ── 参数解析 ──────────────────────────────────────────────────────

function parseArgs(argv: string[]): { directory: string; verbose: boolean } {
  let directory = process.cwd();
  let verbose = false;
  for (const arg of argv) {
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (!arg.startsWith("-")) {
      directory = path.resolve(arg);
    }
  }
  return { directory, verbose };
}

// ── 主流程 ────────────────────────────────────────────────────────

async function main() {
  const { directory, verbose } = parseArgs(process.argv.slice(2));

  console.log(`▸ project directory: ${directory}`);
  console.log(`▸ starting opencode server...`);

  // 1. 自动拉起/获取单例服务端
  const serverUrl = await ensureOpencodeServer({ verbose });

  console.log(`▸ server up at ${serverUrl}`);

  // 2. 初始化 AgentInsight (内部自动使用该 server URL)
  const insight = new AgentInsight({
    baseURL: serverUrl,
    password: process.env.OPENCODE_SERVER_PASSWORD,
    timeout: 180_000,
    maxRetries: 2,
    logLevel: (process.env.OPENCODE_LOG_LEVEL as any) || "info",
    directory, // 绑定该工作目录
  });

  // 3. 构造 Session 的权限，允许访问工作目录和 /tmp
  const permissions = [
    { permission: "external_directory", pattern: directory, action: "allow" },
    { permission: "external_directory", pattern: `${directory}/*`, action: "allow" },
    { permission: "external_directory", pattern: "/tmp/*", action: "allow" },
  ];

  // 4. 创建 session
  let sessionResp: Record<string, unknown> | null = null;
  try {
    sessionResp = await insight.createSession({
      title: `chat-demo @ ${path.basename(directory)}`,
    });
  } catch (err) {
    console.error("failed to create session:", err);
    await stopOpencodeServer();
    process.exit(1);
  }

  let sessionID = String(sessionResp?.id ?? "");
  if (!sessionID) {
    console.error("failed to create session: no session id returned");
    await stopOpencodeServer();
    process.exit(1);
  }
  console.log(`▸ session id: ${sessionID}`);
  console.log(`\n  Type your message. /exit to quit, /reset for new session, /id to show session id.\n`);

  // 进程退出时清理
  let cleaningUp = false;
  const cleanup = async (code = 0) => {
    if (cleaningUp) return;
    cleaningUp = true;
    process.stdout.write("\n▸ shutting down...\n");
    try {
      await insight.abortSession(sessionID).catch(() => {});
    } catch {
      /* ignore */
    }
    await stopOpencodeServer();
    process.exit(code);
  };
  process.once("SIGINT", () => void cleanup(0));
  process.once("SIGTERM", () => void cleanup(0));

  // 交互式 REPL
  const rl = readline.createInterface({ input, output });

  while (true) {
    let userInput: string;
    try {
      userInput = (await rl.question("› ")).trim();
    } catch {
      // Ctrl-D / readline closed
      break;
    }

    if (!userInput) continue;

    // 命令处理
    if (userInput === "/exit" || userInput === "/quit") {
      break;
    }
    if (userInput === "/id") {
      console.log(`  session: ${sessionID}`);
      continue;
    }
    if (userInput === "/reset") {
      await insight.abortSession(sessionID).catch(() => {});
      try {
        const newResp = await insight.createSession({
          title: `chat-demo @ ${path.basename(directory)}`,
        });
        sessionID = String(newResp?.id ?? "");
        console.log(`  ▸ new session: ${sessionID}`);
      } catch (err) {
        console.error("  failed to create new session");
      }
      continue;
    }

    // 组装 payload，透传权限配置
    const payload: SendPromptPayload = {
      text: userInput,
      agent: process.env.OPENCODE_AGENT || "build",
      model: {
        providerID:
          (process.env.OPENCODE_PROVIDER_ID || "deepseek-official") === "deepseek"
            ? "deepseek-official"
            : process.env.OPENCODE_PROVIDER_ID || "deepseek-official",
        modelID: process.env.OPENCODE_MODEL_ID || "deepseek-chat",
        apiKey: process.env.OPENCODE_API_KEY || process.env.DEEPSEEK_API_KEY,
        baseURL:
          process.env.OPENCODE_PROVIDER_BASE_URL ||
          (((process.env.OPENCODE_PROVIDER_ID || "deepseek-official") === "deepseek" ||
            (process.env.OPENCODE_PROVIDER_ID || "deepseek-official") === "deepseek-official")
            ? "https://api.deepseek.com"
            : undefined),
        headers: process.env.OPENCODE_PROVIDER_HEADERS
          ? JSON.parse(process.env.OPENCODE_PROVIDER_HEADERS)
          : undefined,
      },
      modelOptions: {
        temperature: 0.7,
        maxTokens: 2048,
      },
      permission: permissions,
      directory,
    };

    // 运行 Chat
    try {
      let inText = false;
      const announcedTools = new Set<string>();
      const finishedTools = new Set<string>();

      await insight.chat(sessionID, payload, {
        onText: (e) => {
          if (!inText) {
            process.stdout.write("\n  ");
            inText = true;
          }
          process.stdout.write(e.delta);
        },
        onReasoning: (e) => {
          if (!e.delta) return;
          process.stdout.write(`\x1b[90m${e.delta}\x1b[0m`);
        },
        onTool: (tool) => {
          if (tool.phase === "start") {
            if (inText) {
              process.stdout.write("\n");
              inText = false;
            }
            if (tool.callID && !announcedTools.has(tool.callID)) {
              announcedTools.add(tool.callID);
              const toolName = tool.name;
              // 简略展示工具输入
              let inputPreview = "";
              if (tool.input && typeof tool.input === "object") {
                const inputObj = tool.input as Record<string, unknown>;
                const keys = Object.keys(inputObj);
                if (keys.length > 0) {
                  const firstKey = keys[0];
                  const v = inputObj[firstKey];
                  if (typeof v === "string") {
                    inputPreview = ` ${v.length > 80 ? v.slice(0, 77) + "..." : v}`;
                  } else {
                    inputPreview = ` (${keys.length} args)`;
                  }
                }
              }
              process.stdout.write(`  ⚙ ${toolName}${inputPreview}\n`);
            }
          } else if (tool.phase === "end") {
            if (inText) {
              process.stdout.write("\n");
              inText = false;
            }

            if (tool.callID) {
              if (finishedTools.has(tool.callID)) return;
              finishedTools.add(tool.callID);
            }

            let outputPreview = "";
            if (tool.output !== undefined) {
              let s = "";
              try {
                s = typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output);
              } catch {
                s = String(tool.output);
              }
              s = s.replace(/\n/g, "\\n");
              if (s.length > 1200) s = s.slice(0, 1197) + "...";
              outputPreview = ` ${s}`;
            }

            const statusPart = tool.status ? ` status=${tool.status}` : "";
            process.stdout.write(`  ✓ ${tool.name}${statusPart}${outputPreview}\n`);
          } else if (tool.phase === "error") {
            if (inText) {
              process.stdout.write("\n");
              inText = false;
            }
            const errMsg = tool.error
              ? (tool.error as any).message || String(tool.error)
              : "unknown error";
            process.stdout.write(`  ✗ tool ${tool.callID} failed: ${errMsg}\n`);
          }
        },
        onAssistantMessage: (e) => {
          if (e.status === "error" && e.error) {
            process.stderr.write(`\n  ✗ error: ${e.error.message || JSON.stringify(e.error)}\n`);
          }
        },
        onSession: (e) => {
          if (e.phase === "error" && e.error) {
            process.stderr.write(`\n  ✗ session error: ${e.error.message || JSON.stringify(e.error)}\n`);
          }
        },
        onQuestion: async (e) => {
          // 在 CLI 场景下提示用户
          if (inText) {
            process.stdout.write("\n");
            inText = false;
          }
          process.stdout.write(`\n[Question Asked] Server asked a question: ${JSON.stringify(e.questions)}\n-> Auto rejecting...\n`);
          return null; // 这里暂时默认拒绝，可以改为 await rl.question(...) 让用户回答
        },
        onPermission: async (e) => {
          if (inText) {
            process.stdout.write("\n");
            inText = false;
          }
          process.stdout.write(`\n[Permission Request] ${e.title ?? e.type ?? e.id} -> 自动 once\n`);
          return "once" as const;
        },
        onError: (err) => {
          process.stderr.write(`\n  ✗ stream error: ${err.message}\n`);
        },
      }, {
        idleTimeoutMs: Number(process.env.OPENCODE_IDLE_TIMEOUT_MS || 60_000),
        streamTimeoutMs: Number(process.env.OPENCODE_STREAM_TIMEOUT_MS || 5 * 60_000),
      });

      if (inText) {
        process.stdout.write("\n");
      }
    } catch (err) {
      console.error(`\n  ✗ error: ${(err as Error).message}`);
    }

    // 末尾留一个空行
    console.log();
  }

  rl.close();
  await cleanup(0);
}

main().catch(async (err) => {
  console.error("\n✗ fatal error:", err instanceof Error ? err.stack : err);
  await stopOpencodeServer().catch(() => {});
  process.exit(1);
});
