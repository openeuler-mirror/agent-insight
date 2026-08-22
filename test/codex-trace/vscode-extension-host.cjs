/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "openeuler.agent-insight-codex-trace";
const EXPECTED_COMMANDS = [
  "agentInsight.codexTrace.openSettings",
  "agentInsight.codexTrace.openLogs",
  "agentInsight.codexTrace.flush",
  "agentInsight.codexTrace.linkCloudAgent",
  "agentInsight.codexTrace.unlinkCloudAgent",
];
const RUN_ID = process.env.AGENT_INSIGHT_VSCODE_RUN_ID || Date.now().toString(36);
const SESSION_ID = `vscode-extension-host-${RUN_ID}`;
const TURN_ID = `vscode-extension-host-turn-${RUN_ID}`;

function av(value) {
  return { stringValue: String(value) };
}

function hook(eventName, workspacePath, extra = {}) {
  return {
    hook_event_name: eventName,
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    cwd: workspacePath,
    model: "extension-host-fixture",
    ...extra,
  };
}

function conversationStart(workspacePath) {
  const attributes = {
    "event.name": "codex.conversation_starts",
    "conversation.id": SESSION_ID,
    cwd: workspacePath,
    originator: "codex_vscode",
    "terminal.type": "vscode",
  };
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: "service.name", value: av("codex-cli") },
          { key: "originator", value: av("codex_vscode") },
          { key: "terminal.type", value: av("vscode") },
        ],
      },
      scopeLogs: [{
        scope: { name: "codex-otel", version: "0.145.0" },
        logRecords: [{
          timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
          attributes: Object.entries(attributes)
            .map(([key, value]) => ({ key, value: av(value) })),
        }],
      }],
    }],
  };
}

function readCollectorConfig() {
  const configPath = path.join(
    os.homedir(),
    ".agent-insight",
    "collectors",
    "codex",
    "config.json",
  );
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function requestRelay(config, pathname, body, method = "POST") {
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
      timeout: 2_500,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Relay returned HTTP ${response.statusCode}: ${text}`));
          return;
        }
        resolve(text ? JSON.parse(text) : {});
      });
    });
    request.on("timeout", () => request.destroy(new Error("Relay request timed out")));
    request.on("error", reject);
    request.end(data);
  });
}

async function waitFor(check, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(lastError ? `${message}: ${lastError.message}` : message);
}

async function run() {
  const resultPath = process.env.AGENT_INSIGHT_VSCODE_RESULT;
  assert.ok(resultPath, "AGENT_INSIGHT_VSCODE_RESULT is required");
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} was not discovered`);
  await extension.activate();
  assert.equal(extension.isActive, true, "extension did not activate");

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of EXPECTED_COMMANDS) {
    assert.ok(commands.has(command), `missing command: ${command}`);
  }

  const settings = vscode.workspace.getConfiguration("agentInsight.codexTrace");
  const observedSettings = {
    enabled: settings.get("enabled"),
    endpoint: settings.get("endpoint"),
    apiKey: settings.get("apiKey"),
    relayPort: settings.get("relayPort"),
    captureFileEdits: settings.get("captureFileEdits"),
    captureTerminal: settings.get("captureTerminal"),
    cloudAgentId: settings.get("cloudAgentId"),
  };
  assert.deepEqual(observedSettings, {
    enabled: true,
    endpoint: "http://127.0.0.1:3000",
    apiKey: "",
    relayPort: 43191,
    captureFileEdits: true,
    captureTerminal: true,
    cloudAgentId: "",
  });

  assert.equal(typeof vscode.window.onDidStartTerminalShellExecution, "function");
  assert.equal(typeof vscode.window.onDidEndTerminalShellExecution, "function");

  const config = readCollectorConfig();
  const relay = (pathname, body, method = "POST") => (
    requestRelay(config, pathname, body, method)
  );
  await waitFor(
    () => relay("/status", undefined, "GET"),
    "collector relay did not become available",
  );

  const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await relay("/hook", hook("SessionStart", workspacePath));
  await relay("/hook", hook("UserPromptSubmit", workspacePath, {
    prompt: "exercise live VS Code events",
  }));
  await relay("/v1/logs", conversationStart(workspacePath));
  await waitFor(async () => {
    const status = await relay("/status", undefined, "GET");
    return status.activeTurns?.some((turn) => (
      turn.sessionId === SESSION_ID &&
      turn.turnId === TURN_ID
    ));
  }, "IDE-originated active turn was not visible");
  await new Promise((resolve) => setTimeout(resolve, 1_250));

  const fixtureUri = vscode.Uri.file(path.join(
    workspacePath,
    `.agent-insight-extension-host-${process.pid}.txt`,
  ));
  let terminal;
  try {
    await vscode.workspace.fs.writeFile(fixtureUri, Buffer.from("before\n"));
    const document = await vscode.workspace.openTextDocument(fixtureUri);
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((builder) => (
      builder.insert(new vscode.Position(1, 0), "after\n")
    ));
    assert.equal(document.getText(), "before\nafter\n");
    assert.equal(await document.save(), true);
    await new Promise((resolve) => setTimeout(resolve, 750));

    await vscode.workspace.getConfiguration("terminal.integrated").update(
      "shellIntegration.enabled",
      true,
      vscode.ConfigurationTarget.Global,
    );
    const terminalOptions = {
      name: "Agent Insight Extension Host Test",
      cwd: workspacePath,
    };
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    if (process.platform === "win32" && fs.existsSync(pwsh)) {
      terminalOptions.shellPath = pwsh;
      terminalOptions.shellArgs = ["-NoLogo"];
    }
    terminal = vscode.window.createTerminal(terminalOptions);
    terminal.show(false);

    const shellIntegration = terminal.shellIntegration || await waitFor(
      () => terminal.shellIntegration,
      "Terminal shell integration was not available within 60 seconds",
    );
    const command = process.platform === "win32"
      ? "Write-Output 'agent-insight-terminal-fixture'"
      : "printf '%s\\n' 'agent-insight-terminal-fixture'";
    const execution = shellIntegration.executeCommand(command);
    const terminalExitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        disposable.dispose();
        reject(new Error("Terminal command did not finish within 60 seconds"));
      }, 60_000);
      const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution !== execution) return;
        clearTimeout(timeout);
        disposable.dispose();
        resolve(event.exitCode);
      });
    });
    assert.equal(terminalExitCode, 0);
    await new Promise((resolve) => setTimeout(resolve, 750));

    await relay("/hook", hook("Stop", workspacePath, {
      result: "extension host verification complete",
    }));
    await relay("/hook", hook("SessionEnd", workspacePath));

    const result = {
      vscodeVersion: vscode.version,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      extensionId: extension.id,
      extensionVersion: extension.packageJSON.version,
      active: extension.isActive,
      commands: EXPECTED_COMMANDS,
      settings: observedSettings,
      terminalShellExecutionApi: true,
      fileEditExecuted: true,
      terminalExecuted: true,
      terminalExitCode,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    terminal?.dispose();
    await vscode.workspace.fs.delete(fixtureUri, { useTrash: false }).then(
      () => {},
      () => {},
    );
  }
}

module.exports = { run };
