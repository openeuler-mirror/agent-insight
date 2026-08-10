import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * 「重跑 setup 指向新平台，上报却还发往老地址」的回归看护。
 *
 * 采集端读配置是 process.env 优先、.env 只补空缺（保留一次性覆盖的能力）。代价是旧终端里
 * 残留的 export 会静默压掉重装写入的新配置——真实事故里 .env 已经是 localhost、插件日志
 * 里却是老服务器地址，全程无任何提示，只能靠翻日志倒推。这两个函数负责把它喊出来。
 */

process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = "1"

/** 造一个假 HOME，往 <home>/.agent-insight/.env 写内容 */
function withFakeHome(envText: string, run: () => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "env-shadow-home-"))
  const previousHome = process.env.HOME
  try {
    fs.mkdirSync(path.join(home, ".agent-insight"), { recursive: true })
    fs.writeFileSync(path.join(home, ".agent-insight", ".env"), envText, "utf8")
    process.env.HOME = home
    run()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map(Object.keys(vars).map((k) => [k, process.env[k]]))
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    run()
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test("env 被进程变量压住时能识别出来（值相同则不算）", async () => {
  const { findShadowedEnvKeys } = await import("../scripts/opencode_uploader_client.js")

  withFakeHome(
    "AGENT_INSIGHT_HOST=http://localhost:3000\nAGENT_INSIGHT_API_KEY=file-key\nAGENT_INSIGHT_MAX_TOOL_IO=4000\n",
    () => {
      withEnv(
        {
          // 旧终端里残留的 export：跟 .env 不一致 → 必须被识别
          AGENT_INSIGHT_HOST: "http://119.3.152.42:3000",
          AGENT_INSIGHT_API_KEY: "shell-key",
          // 值一样 → 不算被压
          AGENT_INSIGHT_MAX_TOOL_IO: "4000",
        },
        () => {
          const shadowed = findShadowedEnvKeys()
          assert.deepEqual(
            shadowed.map((x: any) => x.key).sort(),
            ["AGENT_INSIGHT_API_KEY", "AGENT_INSIGHT_HOST"],
            "值不同的键才算被压住；值相同的不该报",
          )
          const host = shadowed.find((x: any) => x.key === "AGENT_INSIGHT_HOST")
          assert.ok(host)
          assert.equal(host.fromFile, "http://localhost:3000")
          assert.equal(host.actual, "http://119.3.152.42:3000")
        },
      )
    },
  )
})

test("进程环境没有覆盖时不误报", async () => {
  const { findShadowedEnvKeys } = await import("../scripts/opencode_uploader_client.js")

  withFakeHome("AGENT_INSIGHT_HOST=http://localhost:3000\n", () => {
    withEnv({ AGENT_INSIGHT_HOST: undefined }, () => {
      assert.deepEqual(findShadowedEnvKeys(), [])
    })
  })
})

test("日志里不打印密钥类的值", async () => {
  const { describeShadowedEnv } = await import("../scripts/opencode_uploader_client.js")

  const line = describeShadowedEnv([
    { key: "AGENT_INSIGHT_HOST", fromFile: "http://localhost:3000", actual: "http://119.3.152.42:3000" },
    { key: "AGENT_INSIGHT_API_KEY", fromFile: "sk-file", actual: "sk-shell" },
  ])

  assert.match(line, /AGENT_INSIGHT_HOST\(\.env=http:\/\/localhost:3000 实际=http:\/\/119\.3\.152\.42:3000\)/)
  assert.match(line, /AGENT_INSIGHT_API_KEY\(值不同,已隐藏\)/)
  assert.doesNotMatch(line, /sk-file|sk-shell/, "密钥的值一律不进日志")
})
