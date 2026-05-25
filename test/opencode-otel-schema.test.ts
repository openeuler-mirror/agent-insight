import test from "node:test"
import assert from "node:assert/strict"
import { isSecretKey, redactJson, sha256Hex } from "../scripts/opencode_otel_schema"

test("otel schema: sha256Hex is deterministic", () => {
  assert.equal(sha256Hex("x"), sha256Hex("x"))
  assert.notEqual(sha256Hex("x"), sha256Hex("y"))
})

test("otel schema: isSecretKey matches common secret keys", () => {
  assert.equal(isSecretKey("apiKey"), true)
  assert.equal(isSecretKey("Authorization"), true)
  assert.equal(isSecretKey("OPENAI_API_KEY"), true)
  assert.equal(isSecretKey("SOME_TOKEN"), true)
  assert.equal(isSecretKey("not_secret"), true)
  assert.equal(isSecretKey("monkey"), false)
})

test("otel schema: redactJson masks secret keys recursively", () => {
  const input = {
    provider: {
      options: {
        apiKey: "sk-real",
        baseUrl: "https://example.com",
      },
    },
    nested: [{ token: "t1" }, { ok: true }],
  }

  const out = redactJson(input as any) as any
  assert.equal(out.provider.options.apiKey, "***")
  assert.equal(out.provider.options.baseUrl, "https://example.com")
  assert.equal(out.nested[0].token, "***")
  assert.equal(out.nested[1].ok, true)
})
