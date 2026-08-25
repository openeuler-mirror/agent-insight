import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const require = createRequire(import.meta.url)
const {
  readEnvValue,
  syncAdminApiKey,
  updateEnvFile,
} = require("../scripts/sync_admin_api_key.js")

test("updateEnvFile replaces upload credentials and preserves unrelated config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-env-"))
  const envPath = path.join(dir, ".env")

  fs.writeFileSync(
    envPath,
    [
      "# header",
      'DATABASE_URL="file:../data/witty_insight.db"',
      "AGENT_INSIGHT_HOST=http://old-host:3000",
      "AGENT_INSIGHT_API_KEY=sk-old",
      "AGENT_INSIGHT_API_KEY=sk-duplicate",
      "AGENT_INSIGHT_SHOW_TASK_STATS=true",
      "",
    ].join("\n"),
  )

  updateEnvFile(envPath, {
    AGENT_INSIGHT_HOST: "http://localhost:3000",
    AGENT_INSIGHT_API_KEY: "sk-new",
  })

  const content = fs.readFileSync(envPath, "utf8")
  assert.match(content, /DATABASE_URL="file:\.\.\/data\/witty_insight\.db"/)
  assert.match(content, /AGENT_INSIGHT_SHOW_TASK_STATS=true/)
  assert.match(content, /AGENT_INSIGHT_HOST=http:\/\/localhost:3000/)
  assert.match(content, /AGENT_INSIGHT_API_KEY=sk-new/)
  assert.equal((content.match(/^AGENT_INSIGHT_API_KEY=/gm) || []).length, 1)
  assert.doesNotMatch(content, /sk-old|sk-duplicate|old-host/)
})

test("updateEnvFile appends upload credentials when they are missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-env-"))
  const envPath = path.join(dir, ".env")

  fs.writeFileSync(envPath, "ORGANIZATION_MODE=false\n")

  updateEnvFile(envPath, {
    AGENT_INSIGHT_HOST: "http://localhost:3001",
    AGENT_INSIGHT_API_KEY: "sk-added",
  })

  const content = fs.readFileSync(envPath, "utf8")
  assert.match(content, /ORGANIZATION_MODE=false/)
  assert.match(content, /AGENT_INSIGHT_HOST=http:\/\/localhost:3001/)
  assert.match(content, /AGENT_INSIGHT_API_KEY=sk-added/)
})

test("syncAdminApiKey preserves a client identity registered by setup", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-sync-"))
  const envPath = path.join(dataRoot, ".env")
  fs.writeFileSync(
    envPath,
    "AGENT_INSIGHT_HOST=http://old-host:3000\nAGENT_INSIGHT_API_KEY=wi_email_user\n",
  )

  const result = await syncAdminApiKey({
    dataRoot,
    port: 3100,
    host: "http://localhost:3100",
    requestApiKey: async () => ({ username: "admin", apiKey: "wi_admin" }),
  })

  assert.equal(result.preservedClientApiKey, true)
  assert.equal(result.clientApiKey, "wi_email_user")
  assert.equal(readEnvValue(envPath, "AGENT_INSIGHT_API_KEY"), "wi_email_user")
  assert.equal(readEnvValue(envPath, "AGENT_INSIGHT_HOST"), "http://localhost:3100")
  assert.equal(
    fs.readFileSync(path.join(dataRoot, ".admin_api_key"), "utf8"),
    "wi_admin",
  )
})

test("syncAdminApiKey initializes the client key only when none exists", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-sync-"))
  fs.writeFileSync(path.join(dataRoot, ".env"), "ORGANIZATION_MODE=false\n")

  const result = await syncAdminApiKey({
    dataRoot,
    port: 3200,
    host: "http://localhost:3200",
    requestApiKey: async () => ({ username: "admin", apiKey: "wi_admin" }),
  })

  assert.equal(result.preservedClientApiKey, false)
  assert.equal(
    readEnvValue(path.join(dataRoot, ".env"), "AGENT_INSIGHT_API_KEY"),
    "wi_admin",
  )
})
