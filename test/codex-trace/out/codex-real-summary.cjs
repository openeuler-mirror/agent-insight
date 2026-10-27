"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");

const evidenceDir = process.env.EVIDENCE_DIR;
const clientHome = process.env.CLIENT_HOME;
const databaseUrl = process.env.DATABASE_URL;
const serverRequire = createRequire(process.env.SERVER_PACKAGE_JSON);
const { PrismaClient } = serverRequire("@prisma/client");
const {
  extractOtlpLogRecords,
} = require("../../../scripts/agent-trace-collectors/codex/codex-trace-core.cjs");

function parseJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function nativeRun(name) {
  const events = parseJsonl(path.join(evidenceDir, `${name}.jsonl`));
  const sessionId = events.find((event) => event.type === "thread.started")?.thread_id;
  const usage = events.findLast((event) => event.type === "turn.completed")?.usage;
  const items = events
    .filter((event) => event.type === "item.completed")
    .map((event) => event.item)
    .filter(Boolean);
  if (!sessionId || !usage) throw new Error(`Incomplete native Codex run: ${name}`);
  return { name, sessionId, native: { usage, items } };
}

async function filesNamed(root, fileName) {
  const result = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesNamed(target, fileName));
    else if (entry.isFile() && entry.name === fileName) result.push(target);
  }
  return result.sort();
}

async function readSpool(frameworkDir) {
  const events = [];
  for (const filePath of await filesNamed(frameworkDir, "events.jsonl")) {
    events.push(...parseJsonl(filePath));
  }
  return events;
}

async function readRawRecords(frameworkDir) {
  const records = [];
  let source = "";
  for (const filePath of await filesNamed(frameworkDir, "raw-otel.jsonl")) {
    const fileSource = await fsp.readFile(filePath, "utf8");
    source += fileSource;
    for (const row of fileSource.split(/\r?\n/).filter(Boolean).map(JSON.parse)) {
      records.push(...extractOtlpLogRecords(row.payload));
    }
  }
  return { records, source };
}

function usageProjection(event) {
  return {
    inputTokens: event?.usage?.input || 0,
    outputTokens: event?.usage?.output || 0,
    cachedInputTokens: event?.attributes?.["codex.usage.cache_read"] || 0,
    reasoningOutputTokens: event?.usage?.reasoning || 0,
    totalTokens: event?.usage?.total || 0,
  };
}

function aggregateUsage(events) {
  return events.reduce((total, event) => {
    const usage = usageProjection(event);
    for (const key of Object.keys(total)) total[key] += usage[key];
    return total;
  }, {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  });
}

function nativeUsageProjection(usage) {
  return {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cachedInputTokens: usage.cached_input_tokens || 0,
    reasoningOutputTokens: usage.reasoning_output_tokens || 0,
    totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
  };
}

function rawUsageProjection(record) {
  const attrs = record?.attributes || {};
  return {
    inputTokens: Number(attrs.input_token_count) || 0,
    outputTokens: Number(attrs.output_token_count) || 0,
    cachedInputTokens: Number(attrs.cached_token_count) || 0,
    reasoningOutputTokens: Number(attrs.reasoning_token_count) || 0,
    totalTokens: Number(attrs.tool_token_count) ||
      (Number(attrs.input_token_count) || 0) + (Number(attrs.output_token_count) || 0),
    ttftMs: Number(attrs.ttft_ms) || null,
  };
}

function aggregateRawUsage(records) {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  for (const record of records) {
    const usage = rawUsageProjection(record);
    for (const key of Object.keys(total)) total[key] += usage[key];
  }
  return total;
}

function credentialStrings(auth) {
  const result = [];
  const visit = (value, key = "") => {
    if (typeof value === "string" && /token|secret|key/i.test(key) && value.length >= 12) {
      result.push(value);
    } else if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
    }
  };
  visit(auth);
  return result;
}

async function waitForExecutions(prisma, ids) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const records = await prisma.execution.findMany({
      where: { id: { in: ids } },
      orderBy: { timestamp: "asc" },
    });
    if (records.length === ids.length) return records;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return prisma.execution.findMany({
    where: { id: { in: ids } },
    orderBy: { timestamp: "asc" },
  });
}

async function main() {
  const runs = ["basic", "automatic-skill", "mcp", "subagent"].map(nativeRun);
  const frameworkDir = path.join(clientHome, ".agent-insight", "otel_data", "codex");
  const spool = await readSpool(frameworkDir);
  const raw = await readRawRecords(frameworkDir);
  const auth = JSON.parse(await fsp.readFile(path.join(clientHome, ".codex", "auth.json"), "utf8"));
  const credentials = credentialStrings(auth);
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const databaseRecords = await waitForExecutions(
    prisma,
    runs.map((run) => run.sessionId),
  );
  await prisma.$disconnect();

  const dbById = new Map(databaseRecords.map((record) => [record.id, record]));
  for (const run of runs) {
    const collected = spool.filter((event) => event.sessionId === run.sessionId);
    const llms = collected.filter((event) => event.kind === "llm");
    const llm = llms.at(-1);
    const rawCompleted = raw.records
      .filter((record) =>
        record.eventName === "codex.sse_event" &&
        record.attributes?.["conversation.id"] === run.sessionId &&
        record.attributes?.["event.kind"] === "response.completed" &&
        (
          Number(record.attributes?.output_token_count) > 0 ||
          Number(record.attributes?.reasoning_token_count) > 0
        ));
    const record = dbById.get(run.sessionId);
    run.collector = {
      eventCount: collected.length,
      kinds: [...new Set(collected.map((event) => event.kind))].sort(),
      provider: llm?.provider,
      model: llm?.model,
      usage: aggregateUsage(llms),
      ttftMs: llms.map((event) => event.attributes?.["codex.ttft_ms"]),
      automaticSkills: collected
        .filter((event) => event.kind === "skill" && event.skill?.triggerMode === "automatic")
        .map((event) => event.skill?.name),
      mcp: collected
        .filter((event) => event.kind === "mcp")
        .map((event) => ({ ...event.mcp, status: event.status })),
      subagents: collected
        .filter((event) => event.kind === "subagent")
        .map((event) => ({
          name: event.name,
          output: event.output,
          status: event.status,
          agentId: event.attributes?.["codex.agent.id"],
          parentId: event.attributes?.["codex.agent.parent_id"],
        })),
    };
    run.native.usage = nativeUsageProjection(run.native.usage);
    run.native.rawOtel = {
      usage: aggregateRawUsage(rawCompleted),
      ttftMs: rawCompleted.map((record) => rawUsageProjection(record).ttftMs),
    };
    run.database = record ? {
      id: record.id,
      framework: record.framework,
      model: record.model,
      tokens: record.tokens,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      reasoningTokens: record.reasoningTokens,
      cacheReadInputTokens: record.cacheReadInputTokens,
      llmCallCount: record.llmCallCount,
      toolCallCount: record.toolCallCount,
      invokedSkills: record.invokedSkills ? JSON.parse(record.invokedSkills) : [],
      finalResult: record.finalResult,
    } : null;
  }

  const basic = runs.find((run) => run.name === "basic");
  const skill = runs.find((run) => run.name === "automatic-skill");
  const mcp = runs.find((run) => run.name === "mcp");
  const subagent = runs.find((run) => run.name === "subagent");
  const redactedRawAttributes = raw.records
    .filter((record) =>
      ["user.email", "user.account_id", "auth_mode"]
        .some((key) => Object.prototype.hasOwnProperty.call(record.attributes || {}, key)))
    .every((record) =>
      ["user.email", "user.account_id", "auth_mode"]
        .filter((key) => Object.prototype.hasOwnProperty.call(record.attributes, key))
        .every((key) => record.attributes[key] === "[REDACTED]"));
  const checks = {
    allExecutionsPersisted: runs.every((run) => run.database),
    basicProviderModelMatch:
      basic.collector.provider === "openai" &&
      basic.collector.model === "gpt-5.6-sol",
    basicUsageMatch:
      JSON.stringify(basic.native.usage) === JSON.stringify(basic.collector.usage) &&
      JSON.stringify(basic.native.usage) ===
        JSON.stringify(basic.native.rawOtel.usage),
    basicTtftMatch:
      basic.native.rawOtel.ttftMs.length > 0 &&
      basic.native.rawOtel.ttftMs.every((value) => value > 0) &&
      JSON.stringify(basic.native.rawOtel.ttftMs) ===
        JSON.stringify(basic.collector.ttftMs),
    automaticSkillCaptured: skill.collector.automaticSkills.includes("zephyr-checksum"),
    mcpCaptured: mcp.collector.mcp.some((entry) =>
      entry.serverName === "fixture" &&
      entry.toolName === "lookup" &&
      entry.status === "ok"),
    subagentCaptured: subagent.collector.subagents.some((entry) =>
      entry.agentId &&
      entry.parentId === "root" &&
      entry.output === "CHILD_CODEX_OK" &&
      entry.status === "ok"),
    rawSensitiveAttributesRedacted: redactedRawAttributes,
    rawCredentialsAbsent:
      credentials.length > 0 &&
      credentials.every((credential) => !raw.source.includes(credential)),
  };

  const result = {
    generatedAt: new Date().toISOString(),
    environment: {
      os: "openEuler 24.03 LTS SP4",
      codex: "0.145.0",
      auth: "ChatGPT",
      model: "gpt-5.6-sol",
    },
    checks,
    runs,
  };
  const target = path.join(evidenceDir, "real-model-summary.json");
  fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ target, checks }, null, 2)}\n`);
  if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
