#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const configModule = fs.existsSync(path.join(__dirname, "mcts-config.cjs"))
  ? path.join(__dirname, "mcts-config.cjs")
  : path.resolve(__dirname, "../../../services/executor/src/mcts-config.cjs");
const { installationMctsConfig, checkMctsRepository, mctsUpstream, saveMctsRepoDir, shellQuote } = require(configModule);
const { preflightUpstream } = require("./run.cjs");
const PACKAGE_FILES = ["core.cjs", "gateway.cjs", "run.cjs", "install.cjs", "mcts-config.cjs", "mcts-failure.cjs"];
const SHARED_FILES = ["trace-transport.cjs", "collaboration-transport.cjs"];
const WRAPPER_MARKER = "# managed-by-agent-insight-mcts-xgovernor-proxy";

function parseArgs(argv) {
  const result = { homeDir: os.homedir(), sourceDir: __dirname, skipVersionCheck: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--home") result.homeDir = path.resolve(argv[++index]);
    else if (argv[index] === "--source-dir") result.sourceDir = path.resolve(argv[++index]);
    else if (argv[index] === "--skip-version-check") result.skipVersionCheck = true;
    else throw new Error(`Unknown install argument: ${argv[index]}`);
  }
  return result;
}

async function copyFile(source, target, mode = 0o600) {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.copyFile(source, target);
  await fsp.chmod(target, mode).catch(() => undefined);
}

async function install(options) {
  const apiKey = String(process.env.AGENT_INSIGHT_API_KEY || "").trim();
  if (!apiKey) throw new Error("AGENT_INSIGHT_API_KEY is required");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!options.skipVersionCheck && (major < 22 || (major === 22 && minor < 19))) {
    throw new Error(`Node.js >=22.19.0 is required; found ${process.versions.node}`);
  }
  const baseUrl = String(process.env.AGENT_INSIGHT_BASE_URL || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
  const agentInsightHome = process.env.AGENT_INSIGHT_HOME
    ? path.resolve(process.env.AGENT_INSIGHT_HOME)
    : path.join(options.homeDir, ".agent-insight");
  const packageDir = path.join(agentInsightHome, "collectors", "mcts-xgovernor-proxy");
  const mcts = installationMctsConfig(agentInsightHome);
  let paths;
  let upstreamUrl = process.env.AGENT_INSIGHT_MCTS_UPSTREAM_URL || "http://127.0.0.1:8787";
  if (process.env.AGENT_INSIGHT_MCTS_REQUIRE_REPO === "1" || mcts.mctsRepoDir) {
    paths = checkMctsRepository(mcts, 'common');
    upstreamUrl = mctsUpstream(paths);
    try { await preflightUpstream(upstreamUrl); }
    catch { throw new Error("无法连接 MCTS config.env 配置的 xGovernor，请确认原有 MCTS 服务可用后重新执行安装命令"); }
  }
  for (const relative of PACKAGE_FILES) {
    const source = !fs.existsSync(path.join(options.sourceDir, relative)) && ["mcts-config.cjs", "mcts-failure.cjs"].includes(relative)
      ? path.join(path.dirname(configModule), relative) : path.join(options.sourceDir, relative);
    await copyFile(source, path.join(packageDir, relative), 0o700);
  }
  for (const sharedFile of SHARED_FILES) {
    const sharedTarget = path.join(agentInsightHome, "collectors", "shared", sharedFile);
    const privateSource = path.join(options.sourceDir, "shared", sharedFile);
    const sharedSource = fs.existsSync(privateSource) ? privateSource : path.resolve(options.sourceDir, "..", "shared", sharedFile);
    // Keep MCTS upgrades independent of transport versions used by other collectors.
    await copyFile(sharedSource, path.join(packageDir, "shared", sharedFile));
    if (!fs.existsSync(sharedTarget)) await copyFile(sharedSource, sharedTarget);
  }

  const configPath = path.join(packageDir, "config.json");
  const config = {
    version: 1,
    apiKey,
    baseUrl,
    upstreamUrl,
    ...(paths ? { mctsRepoDir: paths.repoDir, mctsPython: paths.python } : {}),
    otlpEndpoint: process.env.AGENT_INSIGHT_OTLP_ENDPOINT || `${baseUrl}/api/ingest/otel/v1/traces`,
    collaborationSessionsEndpoint: process.env.AGENT_INSIGHT_MCTS_COLLABORATION_SESSIONS_ENDPOINT || `${baseUrl}/api/ingest/collaborations/sessions`,
    collaborationEventsEndpoint: process.env.AGENT_INSIGHT_MCTS_COLLABORATION_EVENTS_ENDPOINT || `${baseUrl}/api/ingest/collaborations/events`,
    proxyEnabled: true,
    captureReasoning: false,
    bypassOnStartFailure: true,
    strict: false,
  };
  const temporary = `${configPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, configPath);

  const binDir = path.join(options.homeDir, ".local", "bin");
  const commandPath = path.join(binDir, "agent-insight-mcts-run");
  if (fs.existsSync(commandPath) && !(await fsp.readFile(commandPath, "utf8")).includes(WRAPPER_MARKER)) {
    throw new Error(`Refusing to replace unmanaged command wrapper at ${commandPath}`);
  }
  await fsp.mkdir(binDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(commandPath, `#!/bin/sh\n${WRAPPER_MARKER}\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(packageDir, "run.cjs"))} "$@"\n`, { mode: 0o700 });
  if (paths) saveMctsRepoDir(agentInsightHome, paths.repoDir, mcts.mctsPython);
  return { packageDir, configPath, commandPath };
}

async function main() {
  const result = await install(parseArgs(process.argv.slice(2)));
  process.stdout.write(`MCTS xGovernor observer installed at ${result.packageDir}\nCommand: ${result.commandPath}\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`MCTS xGovernor observer installation failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { PACKAGE_FILES, SHARED_FILES, WRAPPER_MARKER, install, parseArgs };
