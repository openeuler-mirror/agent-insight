#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const { HOOK_EVENTS } = require("./codex-trace-core.cjs");
const { handlerMatches, OTEL_BEGIN, OTEL_END } = require("./config-core.cjs");
const { loadCollectorConfig } = require("./relay.cjs");
const { sha256 } = require("../shared/trace-transport.cjs");

function relayStatus(config) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: config.relayPort,
      path: "/status",
      method: "GET",
      headers: {
        "x-agent-insight-relay": config.installSecret,
      },
      timeout: 500,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Relay returned HTTP ${response.statusCode}`));
          return;
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      });
    });
    request.on("timeout", () => request.destroy(new Error("Relay status timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function check(configPath) {
  const config = loadCollectorConfig(configPath);
  const collectorDir = path.dirname(config.configPath);
  const state = JSON.parse(
    await fs.readFile(path.join(collectorDir, "install-state.json"), "utf8"),
  );
  const hooks = JSON.parse(await fs.readFile(state.hooksPath, "utf8"));
  const missingHooks = HOOK_EVENTS.filter((eventName) => !(
    Array.isArray(hooks.hooks?.[eventName]) &&
    hooks.hooks[eventName].some((group) =>
      Array.isArray(group?.hooks) &&
      group.hooks.some((handler) => handlerMatches(handler, state.handlerPath)),
    )
  ));
  const handlerHash = sha256(await fs.readFile(state.handlerPath));
  const codexConfig = await fs.readFile(state.codexConfigPath, "utf8");
  const otelConfigured = codexConfig.includes(OTEL_BEGIN) && codexConfig.includes(OTEL_END);
  const status = await relayStatus(config).catch((error) => ({ connected: false, error: error.message }));
  return {
    ok: missingHooks.length === 0 &&
      handlerHash === state.handlerSha256 &&
      (otelConfigured || Boolean(state.otelConflict)) &&
      status.connected === true,
    missingHooks,
    handlerHashMatches: handlerHash === state.handlerSha256,
    otelConfigured,
    otelConflict: state.otelConflict,
    relay: status,
  };
}

async function main() {
  const result = await check(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write([
    "Hook trust is maintained by Codex and cannot be written by this installer.",
    "Start Codex, run /hooks, review the Agent Insight command path, choose Trust,",
    "restart Codex, and run a test prompt before checking Agent Insight.",
  ].join(" ") + "\n");
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Agent Insight Codex self-check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { check, relayStatus };
