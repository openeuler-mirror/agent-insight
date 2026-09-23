#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const { MctsProxyCore, FRAMEWORK } = require("./core.cjs");
const { createGateway } = require("./gateway.cjs");
const {
  DurableTraceUploader,
  DurableTraceWriter,
  apiKeyHash,
} = require("../shared/trace-transport.cjs");
const { DurableCollaborationOutbox } = require("../shared/collaboration-transport.cjs");

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
  const baseUrl = String(env.AGENT_INSIGHT_BASE_URL || file.baseUrl || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const bool = (value, fallback) => value === undefined
    ? fallback
    : ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
  const bypassOnStartFailure = bool(env.AGENT_INSIGHT_MCTS_BYPASS_ON_START_FAILURE, file.bypassOnStartFailure !== false);
  return {
    agentInsightHome,
    configPath,
    apiKey: String(env.AGENT_INSIGHT_API_KEY || file.apiKey || "").trim(),
    upstreamUrl: String(args.upstream || env.AGENT_INSIGHT_MCTS_UPSTREAM_URL || env.XGOVERNOR_BASE_URL || file.upstreamUrl || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    otlpEndpoint: env.AGENT_INSIGHT_OTLP_ENDPOINT || file.otlpEndpoint || `${baseUrl}/api/ingest/otel/v1/traces`,
    collaborationSessionsEndpoint: env.AGENT_INSIGHT_MCTS_COLLABORATION_SESSIONS_ENDPOINT || file.collaborationSessionsEndpoint || `${baseUrl}/api/ingest/collaborations/sessions`,
    collaborationEventsEndpoint: env.AGENT_INSIGHT_MCTS_COLLABORATION_EVENTS_ENDPOINT || file.collaborationEventsEndpoint || `${baseUrl}/api/ingest/collaborations/events`,
    proxyEnabled: bool(env.AGENT_INSIGHT_MCTS_PROXY_ENABLED, file.proxyEnabled !== false),
    captureReasoning: args.captureReasoning || bool(env.AGENT_INSIGHT_MCTS_CAPTURE_REASONING, file.captureReasoning === true),
    strict: args.strict || bool(env.AGENT_INSIGHT_MCTS_STRICT, file.strict === true) || !bypassOnStartFailure,
  };
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
  if (!config.proxyEnabled) {
    process.stderr.write("Agent Insight MCTS observer disabled by configuration; running command directly.\n");
    const result = await childResult(runChild(args.command, process.env));
    process.exitCode = result.code ?? signalExitCode(result.signal);
    return;
  }
  if (!config.apiKey) {
    if (config.strict) throw new Error("AGENT_INSIGHT_API_KEY is required in strict mode");
    process.stderr.write("Agent Insight MCTS observer disabled: no API key; running command directly.\n");
    const result = await childResult(runChild(args.command, process.env));
    process.exitCode = result.code ?? signalExitCode(result.signal);
    return;
  }

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
    const result = await childResult(runChild(args.command, process.env));
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
  const child = runChild(args.command, { ...process.env, XGOVERNOR_BASE_URL: gateway.url }, line => core.observeStdoutLine(line));
  const forward = signal => child.kill(signal);
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const result = await childResult(child);
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  clearInterval(traceTimer);
  clearInterval(relationshipTimer);
  await bounded(() => traceFlush);
  await bounded(() => relationshipFlush);
  await core.finish(result.code, result.signal);
  await bounded(() => uploader.flushOnce());
  await bounded(() => outbox.flushOnce());
  await gateway.close();
  process.exitCode = result.code ?? signalExitCode(result.signal);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`Agent Insight MCTS launcher failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { bounded, childResult, loadConfig, main, parseArgs, preflightUpstream, runChild, signalExitCode, teeLines };
