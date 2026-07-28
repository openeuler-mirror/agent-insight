#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  atomicWriteFile,
  removeCollectorHooks,
  serializeHooksDocument,
  uninstallOtelBlock,
} = require("./config-core.cjs");
const { apiKeyHash } = require("../shared/trace-transport.cjs");

const EXTENSION_ID = "openeuler.agent-insight-codex-trace";

function parseArgs(argv) {
  const options = {
    purge: false,
    keepFiles: false,
    uninstallEditors: true,
    homeDir: os.homedir(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--purge") options.purge = true;
    else if (arg === "--keep-files") options.keepFiles = true;
    else if (arg === "--keep-extension") options.uninstallEditors = false;
    else if (arg === "--home") options.homeDir = path.resolve(argv[++index]);
    else throw new Error(`Unknown uninstall argument: ${arg}`);
  }
  return options;
}

function expectedCollectorDir(homeDir = os.homedir()) {
  return path.resolve(homeDir, ".agent-insight", "collectors", "codex");
}

function assertManagedPath(candidate, homeDir = os.homedir()) {
  const expected = expectedCollectorDir(homeDir);
  if (path.resolve(candidate) !== expected) {
    throw new Error(`Refusing to remove unexpected collector path: ${candidate}`);
  }
  return expected;
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function stopRelay(collectorDir) {
  const config = await readJson(path.join(collectorDir, "config.json")).catch(() => undefined);
  if (!config?.apiKey) return false;
  const stateDir = path.join(
    config.homeDir || os.homedir(),
    ".agent-insight",
    "otel_data",
    "codex",
    apiKeyHash(config.apiKey),
  );
  const processState = await readJson(path.join(stateDir, "relay-state.json")).catch(() => undefined);
  const lockState = await readJson(path.join(stateDir, "relay.lock")).catch(() => undefined);
  if (!Number.isInteger(processState?.pid) || processState.pid !== lockState?.pid) return false;
  try {
    process.kill(processState.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function uninstallEditorExtensions() {
  const results = [];
  for (const command of ["code", "cursor", "windsurf"]) {
    const probe = spawnSync(command, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (probe.error || probe.status !== 0) continue;
    const result = spawnSync(command, ["--uninstall-extension", EXTENSION_ID], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    results.push({ command, status: result.status });
  }
  return results;
}

async function uninstall(options, homeDir = os.homedir()) {
  const collectorDir = assertManagedPath(__dirname, homeDir);
  const state = await readJson(path.join(collectorDir, "install-state.json"));
  const config = await readJson(path.join(collectorDir, "config.json"));

  const hooksDocument = await readJson(state.hooksPath);
  const hooksMutation = removeCollectorHooks(hooksDocument, {
    handlerPath: state.handlerPath,
  });
  const remainingHookKeys = Object.keys(hooksMutation.document.hooks || {});
  const remainingTopLevel = Object.keys(hooksMutation.document)
    .filter((key) => key !== "hooks" || remainingHookKeys.length > 0);
  if (!state.hooksFileExisted && remainingTopLevel.length === 0) {
    await fsp.unlink(state.hooksPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  } else {
    await atomicWriteFile(state.hooksPath, serializeHooksDocument(hooksMutation.document));
  }

  const configToml = await fsp.readFile(state.codexConfigPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const otelMutation = uninstallOtelBlock(configToml, state.previousOtelBlock);
  if (otelMutation.changed) {
    if (!state.codexConfigExisted && !otelMutation.source) {
      await fsp.unlink(state.codexConfigPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    } else {
      await atomicWriteFile(state.codexConfigPath, otelMutation.source);
    }
  }

  const stoppedRelay = await stopRelay(collectorDir);
  const editorResults = options.uninstallEditors ? uninstallEditorExtensions() : [];
  let purgedPath;
  if (options.purge) {
    const namespaceRoot = path.resolve(
      config.homeDir || homeDir,
      ".agent-insight",
      "otel_data",
      "codex",
    );
    const candidate = path.resolve(namespaceRoot, apiKeyHash(config.apiKey));
    if (path.dirname(candidate) !== namespaceRoot) {
      throw new Error(`Refusing to purge unexpected spool path: ${candidate}`);
    }
    await fsp.rm(candidate, { recursive: true, force: true });
    purgedPath = candidate;
  }

  if (!options.keepFiles) {
    await fsp.rm(collectorDir, { recursive: true, force: true });
  }
  return {
    hooksRemoved: hooksMutation.removed,
    otelRestored: otelMutation.changed,
    stoppedRelay,
    editorResults,
    purgedPath,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await uninstall(options, options.homeDir);
  process.stdout.write(
    `Agent Insight Codex collector removed (${result.hooksRemoved} Hook handlers).\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Agent Insight Codex uninstall failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXTENSION_ID,
  assertManagedPath,
  expectedCollectorDir,
  parseArgs,
  stopRelay,
  uninstall,
  uninstallEditorExtensions,
};
