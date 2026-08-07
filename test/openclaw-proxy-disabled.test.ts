import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

test("OpenClaw model proxy is disabled without forwarding any request", async () => {
  const originalFetch = globalThis.fetch
  let upstreamCalls = 0
  globalThis.fetch = (async () => {
    upstreamCalls += 1
    return new Response(JSON.stringify({ id: "unexpected-upstream-response" }), { status: 200 })
  }) as typeof fetch

  try {
    const { POST } = await import("@/app/api/proxy/v1/chat/completions/route")
    const requests = [
      new Request("http://localhost/api/proxy/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      }),
      new Request("http://localhost/api/proxy/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer caller-owned-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "example", messages: [{ role: "user", content: "hello" }] }),
      }),
    ]

    for (const request of requests) {
      const response = await POST(request)
      assert.equal(response.status, 410)
      assert.match(await response.text(), /disabled|已停用/i)
    }
    assert.equal(upstreamCalls, 0, "compatibility endpoint must never call a model provider")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("disabled proxy cannot read platform credentials", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/proxy/v1/chat/completions/route.ts"),
    "utf8",
  )
  assert.doesNotMatch(source, /getActiveConfig|WITTY_API_KEY|PROXY_DEEPSEEK_BASE_URL/)
  assert.doesNotMatch(source, /fetch\s*\(/)
})

test("obsolete OpenClaw demo scripts are removed", () => {
  for (const file of ["scripts/start_openclaw_test.ps1", "scripts/install_openclaw_demo.ps1"]) {
    assert.equal(fs.existsSync(path.join(process.cwd(), file)), false, `${file} must not remain in the repository`)
  }
})
