import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const require = createRequire(import.meta.url)
const { updateEnvFile } = require("../scripts/sync_admin_api_key.js")

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
