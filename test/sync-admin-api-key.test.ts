import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const require = createRequire(import.meta.url)
const {
  readEnvValue,
  requestLoginMode,
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
    requestLoginMode: async () => "standalone",
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
    requestLoginMode: async () => "standalone",
    requestApiKey: async () => ({ username: "admin", apiKey: "wi_admin" }),
  })

  assert.equal(result.preservedClientApiKey, false)
  assert.equal(
    readEnvValue(path.join(dataRoot, ".env"), "AGENT_INSIGHT_API_KEY"),
    "wi_admin",
  )
})

test("syncAdminApiKey skips admin provisioning in IDaaS mode and preserves the client key", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-sync-"))
  const envPath = path.join(dataRoot, ".env")
  fs.writeFileSync(
    envPath,
    "LOGIN_MODE=idaas_oauth\nAGENT_INSIGHT_HOST=http://old-host:3000\nAGENT_INSIGHT_API_KEY=wi_email_user\n",
  )
  let adminRequestCount = 0

  const result = await syncAdminApiKey({
    dataRoot,
    port: 3300,
    host: "http://localhost:3300",
    requestLoginMode: async () => "idaas_oauth",
    requestApiKey: async () => {
      adminRequestCount += 1
      throw new Error("admin API key must not be requested")
    },
  })

  assert.equal(result.skipped, true)
  assert.equal(result.loginMode, "idaas_oauth")
  assert.equal(result.preservedClientApiKey, true)
  assert.equal(adminRequestCount, 0)
  assert.equal(readEnvValue(envPath, "AGENT_INSIGHT_API_KEY"), "wi_email_user")
  assert.equal(readEnvValue(envPath, "AGENT_INSIGHT_HOST"), "http://localhost:3300")
  assert.equal(fs.existsSync(path.join(dataRoot, ".admin_api_key")), false)
})

test("requestLoginMode reads the server login mode as the readiness check", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/api/eval/config/status?check_login=true")
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ login_mode: "idaas_oauth", org_mode: false }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port")

  try {
    assert.equal(await requestLoginMode(address.port, "127.0.0.1", 1000), "idaas_oauth")
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test("syncAdminApiKey leaves the client key empty when IDaaS has not issued one", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-sync-"))
  const envPath = path.join(dataRoot, ".env")
  fs.writeFileSync(envPath, "LOGIN_MODE=idaas_oauth\n")

  const result = await syncAdminApiKey({
    dataRoot,
    host: "http://localhost:3400",
    requestLoginMode: async () => "idaas_oauth",
    requestApiKey: async () => {
      throw new Error("admin API key must not be requested")
    },
  })

  assert.equal(result.skipped, true)
  assert.equal(result.preservedClientApiKey, false)
  assert.equal(readEnvValue(envPath, "AGENT_INSIGHT_API_KEY"), "")
  assert.equal(readEnvValue(envPath, "AGENT_INSIGHT_HOST"), "http://localhost:3400")
})
