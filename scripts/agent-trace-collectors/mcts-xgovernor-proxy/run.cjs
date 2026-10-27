#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const { parseEnv } = require("node:util");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const { MctsProxyCore, FRAMEWORK } = require("./core.cjs");
const { createGateway } = require("./gateway.cjs");
const { installationMctsConfig, mctsPaths, mctsUpstream, proxyPythonScript } = require(
  fs.existsSync(path.join(__dirname, "mcts-config.cjs"))
    ? "./mcts-config.cjs" : "../../../services/executor/src/mcts-config.cjs"
);
const {
  DurableTraceUploader,
  DurableTraceWriter,
  apiKeyHash,
} = require(fs.existsSync(path.join(__dirname, "shared", "trace-transport.cjs"))
  ? "./shared/trace-transport.cjs" : "../shared/trace-transport.cjs");
const { DurableCollaborationOutbox } = require(fs.existsSync(path.join(__dirname, "shared", "collaboration-transport.cjs"))
  ? "./shared/collaboration-transport.cjs" : "../shared/collaboration-transport.cjs");

const LIVENESS_INTERVAL_MS = 60_000;

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const flags = separator >= 0 ? argv.slice(0, separator) : [];
  const command = separator >= 0 ? argv.slice(separator + 1) : argv;
  const result = { command, strict: false, captureReasoning: false };
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--strict") result.strict = true;
    else if (flag === "--capture-reasoning") result.captureReasoning = true;
    else if (flag === "--upstream") result.upstream = flags[++index];
    else if (flag === "--config") result.configPath = path.resolve(flags[++index]);
    else throw new Error(`Unknown launcher argument: ${flag}`);
  }
  if (!result.command.length) throw new Error("Usage: agent-insight-mcts-run [options] -- <MCTS command> [args...]");
  return result;
}

async function readConfig(configPath) {
  try {
    return JSON.parse(await fsp.readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function loadConfig(args, env = process.env) {
  const agentInsightHome = env.AGENT_INSIGHT_HOME
    ? path.resolve(env.AGENT_INSIGHT_HOME)
    : path.join(os.homedir(), ".agent-insight");
  const configPath = args.configPath || path.join(agentInsightHome, "collectors", "mcts-xgovernor-proxy", "config.json");
  const file = await readConfig(configPath);
  // Benchmark runs use a private spool HOME; credentials belong to the installed collector.
  const packageDir = path.dirname(configPath);
  const installationHome = path.basename(packageDir) === "mcts-xgovernor-proxy"
    && path.basename(path.dirname(packageDir)) === "collectors"
    ? path.dirname(path.dirname(packageDir)) : agentInsightHome;
  let shared = {};
  try { shared = parseEnv(await fsp.readFile(path.join(installationHome, ".env"), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot read MCTS shared collector credentials");
  }
  const apiKey = String(env.AGENT_INSIGHT_API_KEY
    || (Object.hasOwn(shared, "AGENT_INSIGHT_API_KEY") ? shared.AGENT_INSIGHT_API_KEY : file.apiKey)
    || "").trim();
  const mcts = installationMctsConfig(agentInsightHome, env);
  const paths = mctsPaths({
    mctsRepoDir: mcts.mctsRepoDir || file.mctsRepoDir,
    mctsPython: mcts.mctsPython || file.mctsPython,
  });
  const baseUrl = String(env.AGENT_INSIGHT_BASE_URL || file.baseUrl || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const bool = (value, fallback) => value === undefined
    ? fallback
    : ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
  const bypassOnStartFailure = bool(env.AGENT_INSIGHT_MCTS_BYPASS_ON_START_FAILURE, file.bypassOnStartFailure !== false);
  return {
    agentInsightHome,
    configPath,
    mctsRepoDir: paths.repoDir,
    mctsPython: paths.python,
    apiKey,
    upstreamUrl: String(args.upstream || (paths.repoDir ? mctsUpstream(paths, env) : env.AGENT_INSIGHT_MCTS_UPSTREAM_URL || env.XGOVERNOR_BASE_URL || file.upstreamUrl || "http://127.0.0.1:8787")).replace(/\/+$/, ""),
    otlpEndpoint: env.AGENT_INSIGHT_OTLP_ENDPOINT || file.otlpEndpoint || `${baseUrl}/api/ingest/otel/v1/traces`,
    collaborationSessionsEndpoint: env.AGENT_INSIGHT_MCTS_COLLABORATION_SESSIONS_ENDPOINT || file.collaborationSessionsEndpoint || `${baseUrl}/api/ingest/collaborations/sessions`,
    collaborationEventsEndpoint: env.AGENT_INSIGHT_MCTS_COLLABORATION_EVENTS_ENDPOINT || file.collaborationEventsEndpoint || `${baseUrl}/api/ingest/collaborations/events`,
    proxyEnabled: bool(env.AGENT_INSIGHT_MCTS_PROXY_ENABLED, file.proxyEnabled !== false),
    captureReasoning: args.captureReasoning || bool(env.AGENT_INSIGHT_MCTS_CAPTURE_REASONING, file.captureReasoning === true),
    strict: args.strict || bool(env.AGENT_INSIGHT_MCTS_STRICT, file.strict === true) || !bypassOnStartFailure,
  };
}

async function preflightTrace(config, fetchImpl = fetch) {
  if (!config.apiKey) throw new Error("MCTS Trace credential missing; rerun the client installer for the intended platform account");
  let response;
  try {
    response = await fetchImpl(config.otlpEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-witty-api-key": config.apiKey },
      body: JSON.stringify({ resourceSpans: [] }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch {
    throw new Error("MCTS Trace preflight failed: platform unreachable or request timed out; MCTS was not started");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error([401, 403].includes(response.status)
      ? "MCTS Trace authentication failed (HTTP " + response.status + "); check AGENT_INSIGHT_API_KEY in the process environment or installation .env; MCTS was not started"
      : "MCTS Trace preflight failed (HTTP " + response.status + "); MCTS was not started");
  }
  const result = await response.json().catch(() => null);
  if (result?.status !== "accepted" || result.received !== 0) {
    throw new Error("MCTS Trace preflight returned an unexpected response; check the platform endpoint; MCTS was not started");
  }
}

async function preflightUpstream(upstreamUrl, timeoutMs = 1_500) {
  const upstream = new URL(upstreamUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || !upstream.hostname || upstream.username || upstream.password) {
    throw new Error("xGovernor upstream must be an HTTP(S) URL without credentials");
  }
  const port = Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80);
  await new Promise((resolve, reject) => {
    const done = (error) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const socket = upstream.protocol === "https:"
      ? tls.connect({ host: upstream.hostname, port, servername: upstream.hostname }, () => done())
      : net.connect({ host: upstream.hostname, port }, () => done());
    socket.setTimeout(timeoutMs, () => done(new Error(`xGovernor upstream preflight timed out after ${timeoutMs}ms`)));
    socket.once("error", done);
  });
}

function teeLines(stream, destination, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    destination.write(chunk);
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) onLine(buffer.replace(/\r$/, ""));
  });
}

function runChild(command, env, onStdoutLine) {
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  teeLines(child.stdout, process.stdout, onStdoutLine || (() => undefined));
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  return child;
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function signalExitCode(signal) {
  return { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal] || 1;
}

async function bounded(task, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); timer.unref?.(); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = await loadConfig(args);
  let pythonBin;
  try {
    if (config.mctsRepoDir) {
      pythonBin = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-insight-mcts-python-"));
      await fsp.writeFile(path.join(pythonBin, "python"), proxyPythonScript(config.mctsPython), { mode: 0o700 });
    }
    await runConfiguredCommand(args, config, pythonBin);
  } finally {
    if (pythonBin) await fsp.rm(pythonBin, { recursive: true, force: true });
  }
}

async function runConfiguredCommand(args, config, pythonBin) {
  const commandEnv = { ...process.env, ...(pythonBin ? { PATH: `${pythonBin}${path.delimiter}${process.env.PATH || ""}` } : {}) };
  if (!config.proxyEnabled) {
    process.stderr.write("Agent Insight MCTS observer disabled by configuration; running command directly.\n");
    const result = await childResult(runChild(args.command, commandEnv));
    process.exitCode = result.code ?? signalExitCode(result.signal);
    return;
  }
  if (!config.apiKey) {
    if (config.strict) throw new Error("AGENT_INSIGHT_API_KEY is required in strict mode");
    process.stderr.write("Agent Insight MCTS observer disabled: no API key; running command directly.\n");
    const result = await childResult(runChild(args.command, commandEnv));
    process.exitCode = result.code ?? signalExitCode(result.signal);
    return;
  }

  await preflightTrace(config);

  const stateDir = path.join(config.agentInsightHome, "otel_data", FRAMEWORK, apiKeyHash(config.apiKey));
  const writer = new DurableTraceWriter({ framework: FRAMEWORK, apiKey: config.apiKey, stateDir });
  const uploader = new DurableTraceUploader({
    framework: FRAMEWORK,
    apiKey: config.apiKey,
    endpoint: config.otlpEndpoint,
    stateDir,
    maxRetries: 1,
  });
  const outbox = new DurableCollaborationOutbox({
    framework: FRAMEWORK,
    apiKey: config.apiKey,
    sessionsEndpoint: config.collaborationSessionsEndpoint,
    eventsEndpoint: config.collaborationEventsEndpoint,
    stateDir: path.join(stateDir, "relationships"),
  });
  const core = new MctsProxyCore({
    writer,
    collaborationOutbox: outbox,
    captureReasoning: config.captureReasoning,
    statePath: path.join(stateDir, "runtime-ledger.json"),
  });

  let gateway;
  try {
    await preflightUpstream(config.upstreamUrl);
    gateway = await createGateway({
      upstreamUrl: config.upstreamUrl,
      onRequest: value => core.observeRequest(value),
      onResponse: value => core.observeResponse(value),
      onSseEvent: value => core.observeSse(value),
    });
  } catch (error) {
    if (config.strict) throw error;
    process.stderr.write(`Agent Insight MCTS observer unavailable (${error.message}); running command directly.\n`);
    const result = await childResult(runChild(args.command, commandEnv));
    process.exitCode = result.code ?? signalExitCode(result.signal);
    return;
  }

  process.stderr.write(`Agent Insight MCTS observer active; xGovernor proxy ${gateway.url}.\n`);
  let traceFlush = Promise.resolve();
  let relationshipFlush = Promise.resolve();
  const traceTimer = setInterval(() => {
    traceFlush = traceFlush.then(() => uploader.flushOnce()).catch(() => undefined);
  }, 10_000);
  const relationshipTimer = setInterval(() => {
    relationshipFlush = relationshipFlush.then(() => outbox.flushOnce()).catch(() => undefined);
  }, 10_000);
  traceTimer.unref?.();
  relationshipTimer.unref?.();
  const child = runChild(args.command, { ...commandEnv, XGOVERNOR_BASE_URL: gateway.url, AGENT_INSIGHT_MCTS_PROXY_URL: gateway.url }, line => core.observeStdoutLine(line));
  const forward = signal => child.kill(signal);
  const onSighup = () => forward("SIGHUP");
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  const livenessTimer = setInterval(() => { void core.pulse(Date.now()); }, LIVENESS_INTERVAL_MS);
  livenessTimer.unref?.();
  process.on("SIGHUP", onSighup);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let result;
  let failure;
  const cleanupErrors = [];
  const cleanup = async operation => {
    try { await operation(); } catch (error) { cleanupErrors.push(error); }
  };
  try {
    result = await childResult(child);
  } catch (error) {
    failure = error;
  } finally {
    process.off("SIGHUP", onSighup);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    clearInterval(livenessTimer);
    clearInterval(traceTimer);
    clearInterval(relationshipTimer);
    await cleanup(() => bounded(() => traceFlush));
    await cleanup(() => bounded(() => relationshipFlush));
    await cleanup(() => core.finish(result?.code ?? 1, result?.signal ?? null));
    await cleanup(() => bounded(() => uploader.flushOnce()));
    await cleanup(() => bounded(() => outbox.flushOnce()));
    await cleanup(() => bounded(() => gateway.close()));
  }
  if (failure) throw failure;
  if (cleanupErrors.length) throw cleanupErrors[0];
  process.exitCode = result.code ?? signalExitCode(result.signal);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`Agent Insight MCTS launcher failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { LIVENESS_INTERVAL_MS, bounded, childResult, loadConfig, main, parseArgs, preflightTrace, preflightUpstream, runChild, signalExitCode, teeLines };
