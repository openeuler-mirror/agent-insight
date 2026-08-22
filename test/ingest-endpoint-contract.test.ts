import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import nextConfig from "../next.config"

/**
 * 上报端点契约：**采集端硬编码的 URL** 必须解析到**我们期望的那个 handler**。
 *
 * 为什么现有 UT 拦不住这类问题：它们要么 `import { POST } from "@/app/api/.../route"`
 * 直接调 handler（完全绕过 URL 解析），要么只断言安装脚本里的 env/参数写对了
 * （不关心那个 URL 最后落到谁手上）。中间这段「URL → handler」的绑定关系没人看。
 *
 * 真实事故：`/api/upload` 是重构前的通用上报端点，重构后靠 next.config 的兼容别名
 * 指向 `/api/ingest/upload`（opencode uploader、openclaw watcher 都还硬编码着它）。
 * 有人把 OpenClaw 的桥接 handler 建在 `src/app/api/upload/route.ts` —— rewrites()
 * 返回数组等价于 afterFiles，优先级低于真实路由，别名被静默遮蔽。opencode 上报的整包
 * record（含 interactions）被桥接丢弃，trace 只剩一条合成的 chat span，全程 200 OK。
 */

const APP_DIR = path.join(process.cwd(), "src", "app")

function routeExists(urlPath: string): boolean {
  const dir = path.join(APP_DIR, urlPath.replace(/^\//, ""))
  return fs.existsSync(path.join(dir, "route.ts")) || fs.existsSync(path.join(dir, "route.tsx"))
}

function resolveFileSystemRoute(urlPath: string): string | null {
  const segments = urlPath.replace(/^\//, "").split("/").filter(Boolean)
  const resolved: string[] = []
  let current = APP_DIR
  for (const segment of segments) {
    const exact = path.join(current, segment)
    if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) {
      current = exact
      resolved.push(segment)
      continue
    }
    const dynamic = fs.readdirSync(current, { withFileTypes: true })
      .find(entry => entry.isDirectory() && /^\[[^.[\]]+\]$/.test(entry.name))
    if (!dynamic) return null
    current = path.join(current, dynamic.name)
    resolved.push(dynamic.name)
  }
  if (!fs.existsSync(path.join(current, "route.ts")) && !fs.existsSync(path.join(current, "route.tsx"))) {
    return null
  }
  return resolved.join("/")
}

/** 目录下（含子目录）所有 route.ts 的 URL 路径 */
function collectRoutes(urlPath: string): string[] {
  const abs = path.join(APP_DIR, urlPath)
  if (!fs.existsSync(abs)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...collectRoutes(path.posix.join(urlPath, entry.name)))
    else if (entry.name === "route.ts" || entry.name === "route.tsx") out.push(urlPath)
  }
  return out
}

type Rewrite = { source: string; destination: string }

async function rewrites(): Promise<Rewrite[]> {
  const result = await (nextConfig.rewrites as () => Promise<unknown>)()
  assert.ok(
    Array.isArray(result),
    "rewrites() 必须返回数组（afterFiles 语义）。改成 {beforeFiles} 形式会翻转优先级，要同步改本测试",
  )
  return result as Rewrite[]
}

/** 把 URL 按 rewrite 规则套一次；命中返回 destination，否则返回 null */
function applyRewrite(urlPath: string, rule: Rewrite): string | null {
  const url = urlPath.replace(/^\//, "").split("/")
  const src = rule.source.replace(/^\//, "").split("/")
  const params: Record<string, string> = {}
  for (let i = 0; i < src.length; i++) {
    const seg = src[i]
    if (seg.startsWith(":") && seg.endsWith("*")) {
      const rest = url.slice(i)
      if (!rest.length) return null
      params[seg.slice(1, -1)] = rest.join("/")
      return "/" + rule.destination.replace(/^\//, "").split("/")
        .map(s => (s.startsWith(":") ? params[s.replace(/^:|\*$/g, "")] ?? s : s)).join("/")
    }
    if (seg.startsWith(":")) {
      if (i >= url.length) return null
      params[seg.slice(1)] = url[i]
      continue
    }
    if (seg !== url[i]) return null
  }
  if (url.length !== src.length) return null
  return "/" + rule.destination.replace(/^\//, "").split("/")
    .map(s => (s.startsWith(":") ? params[s.replace(/^:|\*$/g, "")] ?? s : s)).join("/")
}

/**
 * 按 Next 的解析顺序找出这个 URL 最终由哪个 route.ts 处理：
 * 先文件系统真实路由，miss 了才轮到 afterFiles rewrite。
 */
async function resolveRoute(urlPath: string): Promise<string | null> {
  const direct = resolveFileSystemRoute(urlPath)
  if (direct) return direct
  for (const rule of await rewrites()) {
    const dest = applyRewrite(urlPath, rule)
    if (dest) {
      const rewritten = resolveFileSystemRoute(dest)
      if (rewritten) return rewritten
    }
  }
  return null
}

/**
 * 每一路采集端的上报/下载端点。`sources` 是**真实写着这个 URL 的文件**——改了客户端
 * 却没同步这里，第一条用例就会红。
 */
const ENDPOINTS: { label: string; url: string; handler: string; sources: string[] }[] = [
  {
    label: "opencode uploader 上报",
    url: "/api/upload",
    handler: "api/ingest/upload",
    sources: ["scripts/opencode_uploader_client.js"],
  },
  {
    label: "openclaw watcher 无损上报",
    url: "/api/ingest/upload",
    handler: "api/ingest/upload",
    sources: ["scripts/openclaw_watcher_client.ts"],
  },
  {
    label: "claude code OTel logs",
    url: "/api/ingest/otel/v1/logs",
    handler: "api/ingest/otel/v1/logs",
    sources: ["src/app/api/ingest/setup/route.ts", "src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "deepseek harness OTel logs",
    url: "/api/ingest/otel/v1/logs",
    handler: "api/ingest/otel/v1/logs",
    sources: ["scripts/agent-trace-collectors/deepseek-harness/cordis.patch.yml"],
  },
  {
    label: "claude code / jiuwen OTel traces",
    url: "/api/ingest/otel/v1/traces",
    handler: "api/ingest/otel/v1/traces",
    sources: ["src/app/api/ingest/setup/route.ts", "src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "hermes 插件 OTel traces",
    url: "/api/ingest/otel/v1/traces",
    handler: "api/ingest/otel/v1/traces",
    sources: ["scripts/hermes_agent_insight_plugin.py"],
  },
  {
    // codeagent 配的是 OTLP base（SDK 自己拼 /v1/traces），所以断言拼接后的完整路径
    label: "codeagent OTLP base + /v1/traces",
    url: "/api/ingest/otel/v1/traces",
    handler: "api/ingest/otel/v1/traces",
    sources: ["src/app/api/ingest/setup/route.ts", "src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "qwen code native OTel logs",
    url: "/api/ingest/otel/v1/logs",
    handler: "api/ingest/otel/v1/logs",
    sources: ["src/app/api/ingest/setup/route.ts", "src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "qwen code native OTel traces",
    url: "/api/ingest/otel/v1/traces",
    handler: "api/ingest/otel/v1/traces",
    sources: ["src/app/api/ingest/setup/route.ts", "src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "opencode 插件下发",
    url: "/api/ingest/setup/opencode",
    handler: "api/ingest/setup/opencode",
    sources: ["src/app/api/ingest/setup/route.ts", "src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "opencode uploader 下发",
    url: "/api/ingest/setup/opencode-uploader",
    handler: "api/ingest/setup/opencode-uploader",
    sources: ["src/app/api/ingest/setup/route.ts", "src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "openclaw watcher 下发",
    url: "/api/ingest/setup/openclaw-watcher",
    handler: "api/ingest/setup/openclaw-watcher",
    sources: ["src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "hermes 插件下发",
    url: "/api/ingest/setup/hermes-plugin",
    handler: "api/ingest/setup/hermes-plugin",
    sources: ["src/app/api/ingest/setup/route.ts", "src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "jiuwen extension 下发",
    url: "/api/ingest/setup/jiuwen-extension",
    handler: "api/ingest/setup/jiuwen-extension",
    sources: ["src/app/api/ingest/setup/route.ts", "src/app/api/ingest/setup/auto/route.ts"],
  },
  {
    label: "deepseek harness package manifest 下发",
    url: "/api/ingest/setup/deepseek-harness/assets/package.json",
    handler: "api/ingest/setup/deepseek-harness/assets/[asset]",
    sources: ["scripts/agent-trace-collectors/deepseek-harness/install.sh"],
  },
  {
    label: "deepseek harness observability code 下发",
    url: "/api/ingest/setup/deepseek-harness/assets/index.js",
    handler: "api/ingest/setup/deepseek-harness/assets/[asset]",
    sources: ["scripts/agent-trace-collectors/deepseek-harness/install.sh"],
  },
  {
    label: "deepseek harness cordis patch 下发",
    url: "/api/ingest/setup/deepseek-harness/assets/cordis.patch.yml",
    handler: "api/ingest/setup/deepseek-harness/assets/[asset]",
    sources: ["scripts/agent-trace-collectors/deepseek-harness/install.sh"],
  },
]

test("采集端硬编码的端点仍写在它声明的来源文件里", () => {
  for (const { label, url, sources } of ENDPOINTS) {
    for (const file of sources) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8")
      assert.ok(
        source.includes(url),
        `${file} 里找不到 ${url}（${label}）。客户端换端点了就同步改 ENDPOINTS 表，别让契约悄悄失效`,
      )
    }
  }
})

test("每个采集端点都解析到期望的 handler", async () => {
  for (const { label, url, handler } of ENDPOINTS) {
    assert.equal(
      await resolveRoute(url),
      handler,
      `${label}：${url} 没有落到 src/app/${handler}/route.ts。`
      + ` 常见原因是有人在别名路径上新建了真实路由——真实路由优先于 rewrite，别名会被静默遮蔽`,
    )
  }
})

test("opencode uploader 真实拼出来的上报路径能解析到 ingest/upload", async () => {
  process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = "1"
  const { getRequestOptions } = await import("../scripts/opencode_uploader_client.js")

  // 两种 host 写法走 uploader 里不同分支，都要落到同一个 handler
  for (const host of ["http://insight.example:3000", "http://insight.example:3000/api"]) {
    const target = new URL(host)
    // 跑测试的机器上配了 http_proxy 时，uploader 会把 path 换成绝对 URL（走代理的写法），
    // 端点本身不变——剥掉 origin 前缀，让用例不受本机代理配置影响。
    const urlPath = String(getRequestOptions(target, "k", 0).path).replace(target.origin, "")
    assert.equal(
      await resolveRoute(urlPath),
      "api/ingest/upload",
      `host=${host} 时 uploader 打的是 ${urlPath}，没落到 ingest/upload`,
    )
  }
})

test("openclaw 旧专用地址仍保留兼容 handler", async () => {
  assert.equal(
    await resolveRoute("/api/ingest/openclaw/upload"),
    "api/ingest/openclaw/upload",
  )
})

test("openclaw watcher 的实际 request path 使用 canonical ingest/upload", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/openclaw_watcher_client.ts"), "utf8")
  assert.match(source, /path:\s*`\$\{basePath\}\/api\/ingest\/upload`/)
})

test("legacy alias 的静态 source 上不能有真实路由（否则别名被遮蔽）", async () => {
  for (const { source, destination } of await rewrites()) {
    if (!source.startsWith("/api/") || source.includes(":")) continue
    assert.equal(
      routeExists(source),
      false,
      `src/app${source}/route.ts 遮蔽了别名 ${source} → ${destination}。`
      + ` 真实路由优先于 rewrite，打 ${source} 的存量客户端会落到这个 handler 上而不是 ${destination}。`
      + ` 把新 handler 挪到自己的命名空间下（例如 ${destination.replace(/\/[^/]+$/, "")}/<名字>）`,
    )
  }
})

/**
 * 已知且可接受的通配别名重叠：`/api/proxy/:taskId/:path*` 只在 taskId 字面量恰好是
 * `v1` 时才与这条路由撞，实际 taskId 是 `ses_xxx`，撞不上。新增重叠必须显式登记。
 */
const KNOWN_WILDCARD_OVERLAPS = new Set(["api/proxy/v1/chat/completions"])

test("legacy alias 的通配 source 下不能有未登记的真实路由", async () => {
  for (const { source, destination } of await rewrites()) {
    if (!source.startsWith("/api/") || !source.includes(":")) continue
    const prefix = source.replace(/^\//, "").split("/")
      .reduce<string[]>((acc, seg) => (seg.startsWith(":") || acc.at(-1) === "" ? [...acc, ""] : [...acc, seg]), [])
      .filter(Boolean).join("/")
    if (!prefix) continue
    for (const route of collectRoutes(prefix)) {
      assert.ok(
        KNOWN_WILDCARD_OVERLAPS.has(route),
        `src/app/${route}/route.ts 落在别名 ${source} → ${destination} 的通配范围内。`
        + ` 确认不会遮蔽存量客户端后，把它登记进 KNOWN_WILDCARD_OVERLAPS`,
      )
    }
  }
})
