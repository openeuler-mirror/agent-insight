/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const vscode = require("vscode");

const {
  EditAccumulator,
  relativeFilePath,
  selectActiveTurn,
  summarizeChanges,
  terminalCommandLine,
} = require("./ide-trace-core.cjs");

let activeRuntime;

function collectorConfigPath() {
  return path.join(os.homedir(), ".agent-insight", "collectors", "codex", "config.json");
}

function readCollectorConfig() {
  const configPath = collectorConfigPath();
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    ...config,
    configPath,
    relayPort: Number(config.relayPort) || 43191,
  };
}

function requestRelay(config, pathname, body, method = "POST", timeoutMs = 750) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      hostname: "127.0.0.1",
      port: config.relayPort,
      path: pathname,
      method,
      headers: {
        "x-agent-insight-relay": config.installSecret,
        ...(data ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        } : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Relay returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({});
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Relay request timed out")));
    request.on("error", reject);
    request.end(data);
  });
}

function startRelay(config) {
  const relayPath = path.join(path.dirname(config.configPath), "relay.cjs");
  const child = spawn(process.execPath, [relayPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_INSIGHT_CODEX_CONFIG: config.configPath,
    },
  });
  child.unref();
}

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function extensionSettings() {
  return vscode.workspace.getConfiguration("agentInsight.codexTrace");
}

async function activate(context) {
  const output = vscode.window.createOutputChannel("Agent Insight Codex Trace", { log: true });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  statusBar.command = "agentInsight.codexTrace.openSettings";
  statusBar.show();
  context.subscriptions.push(output, statusBar);

  let config;
  let latestStatus = { connected: false, activeTurns: [] };
  let stopped = false;
  const clientId = `${vscode.env.appName}:${process.pid}:${Date.now()}`;
  const editAccumulator = new EditAccumulator({ windowMs: 500 });
  const editTimers = new Map();
  const terminalStarts = new Map();

  const updateStatusBar = (state, detail) => {
    if (!extensionSettings().get("enabled", true)) {
      statusBar.text = "$(circle-slash) Codex Trace";
      statusBar.tooltip = "Agent Insight Codex Trace is disabled";
      return;
    }
    if (state === "connected") {
      statusBar.text = latestStatus.activeTurns?.length
        ? "$(pulse) Codex Trace"
        : "$(check) Codex Trace";
      statusBar.tooltip = latestStatus.activeTurns?.length
        ? "Connected with an active Codex IDE turn"
        : "Connected; waiting for a Codex IDE turn";
    } else if (state === "spooling") {
      statusBar.text = "$(sync~spin) Codex Trace";
      statusBar.tooltip = "Writing trace events to the local spool";
    } else {
      statusBar.text = "$(warning) Codex Trace";
      statusBar.tooltip = detail || "Codex trace relay is unavailable";
    }
  };

  const connect = async () => {
    if (!extensionSettings().get("enabled", true)) {
      updateStatusBar("disabled");
      return;
    }
    try {
      config = readCollectorConfig();
      latestStatus = await requestRelay(config, "/status", undefined, "GET");
      await requestRelay(config, "/lease", { clientId, action: "acquire" });
      updateStatusBar("connected");
    } catch (error) {
      if (config) startRelay(config);
      latestStatus = { connected: false, activeTurns: [] };
      updateStatusBar("error", error.message);
    }
  };

  const poll = setInterval(() => {
    if (!stopped) connect().catch(() => {});
  }, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  await connect();

  const sendIdeEvent = async (event) => {
    if (!config || !extensionSettings().get("enabled", true)) return;
    updateStatusBar("spooling");
    try {
      const cloudAgentId = extensionSettings().get("cloudAgentId", "");
      const result = await requestRelay(config, "/ide-event", {
        ...event,
        workspaceFolders: workspaceFolders(),
        ...(cloudAgentId ? { cloudAgentId, cloudIdSource: "user" } : {}),
      });
      if (!result.attributed) output.debug("IDE event left unattributed by the active turn gate");
      updateStatusBar("connected");
    } catch (error) {
      output.error(`Unable to send IDE event: ${error.message}`);
      updateStatusBar("error", error.message);
    }
  };

  const flushEdit = async (key) => {
    editTimers.delete(key);
    const event = editAccumulator.take(key);
    if (event) await sendIdeEvent(event);
  };

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!extensionSettings().get("captureFileEdits", true)) return;
    if (event.document.uri.scheme !== "file" || event.contentChanges.length === 0) return;
    if (!selectActiveTurn(latestStatus, workspaceFolders())) return;
    const relativePath = relativeFilePath(event.document.uri.fsPath, workspaceFolders());
    if (!relativePath) return;
    const key = event.document.uri.toString();
    editAccumulator.add(key, {
      type: "file_edit",
      eventId: `${key}:${Date.now()}`,
      relativePath,
      languageId: event.document.languageId,
      changes: summarizeChanges(event.contentChanges),
    });
    clearTimeout(editTimers.get(key));
    editTimers.set(key, setTimeout(() => {
      flushEdit(key).catch((error) => output.error(error.message));
    }, 500));
  }));

  if (
    typeof vscode.window.onDidStartTerminalShellExecution === "function" &&
    typeof vscode.window.onDidEndTerminalShellExecution === "function"
  ) {
    context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution((event) => {
      if (!extensionSettings().get("captureTerminal", true)) return;
      if (!selectActiveTurn(latestStatus, workspaceFolders())) return;
      terminalStarts.set(event.execution, {
        type: "terminal",
        eventId: `terminal:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        startedAt: Date.now(),
        commandLine: terminalCommandLine(event),
        terminalName: event.terminal?.name,
        cwd: event.terminal?.shellIntegration?.cwd?.fsPath,
      });
    }));
    context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution((event) => {
      const started = terminalStarts.get(event.execution);
      if (!started) return;
      terminalStarts.delete(event.execution);
      sendIdeEvent({
        ...started,
        timestampMs: Date.now(),
        exitCode: event.exitCode,
      }).catch((error) => output.error(error.message));
    }));
  } else {
    output.warn("Terminal Shell Execution API is unavailable in this editor version");
  }

  context.subscriptions.push(vscode.commands.registerCommand(
    "agentInsight.codexTrace.openSettings",
    () => vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:openeuler.agent-insight-codex-trace",
    ),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "agentInsight.codexTrace.openLogs",
    () => output.show(),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "agentInsight.codexTrace.flush",
    async () => {
      if (!config) throw new Error("Codex trace relay is not configured");
      const result = await requestRelay(config, "/flush", {});
      vscode.window.showInformationMessage(
        `Agent Insight uploaded ${result.uploadedEvents || 0} trace events.`,
      );
    },
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "agentInsight.codexTrace.linkCloudAgent",
    async () => {
      const value = await vscode.window.showInputBox({
        title: "Link Cloud Agent",
        prompt: "Enter a known Codex Cloud Agent ID",
        ignoreFocusOut: true,
      });
      if (value?.trim()) {
        await extensionSettings().update(
          "cloudAgentId",
          value.trim(),
          vscode.ConfigurationTarget.Global,
        );
      }
    },
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "agentInsight.codexTrace.unlinkCloudAgent",
    () => extensionSettings().update(
      "cloudAgentId",
      "",
      vscode.ConfigurationTarget.Global,
    ),
  ));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("agentInsight.codexTrace")) connect().catch(() => {});
  }));

  activeRuntime = {
    async dispose() {
      stopped = true;
      clearInterval(poll);
      for (const timer of editTimers.values()) clearTimeout(timer);
      for (const key of editAccumulator.keys()) await flushEdit(key);
      if (config) {
        await requestRelay(config, "/flush", {}, "POST", 2500).catch(() => {});
        await requestRelay(config, "/lease", { clientId, action: "release" }).catch(() => {});
      }
    },
  };
}

async function deactivate() {
  await activeRuntime?.dispose();
  activeRuntime = undefined;
}

module.exports = { activate, deactivate, readCollectorConfig, requestRelay, startRelay };
