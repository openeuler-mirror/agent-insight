import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import AdmZip from "adm-zip"

import { GET as getSetup } from "@/app/api/ingest/setup/route"
import { GET as getAutoSetup } from "@/app/api/ingest/setup/auto/route"
import { GET as getQoderDesktopVsix } from "@/app/api/ingest/setup/qoder-desktop-vsix/route"
import { GET as getQoderJetBrainsPlugin } from "@/app/api/ingest/setup/qoder-jetbrains-plugin/route"
import { getQoderPluginPackageBuildInfo } from "@/lib/ingest/qoder-plugin-package"
import {
  DEFAULT_QODER_JETBRAINS_PACKAGE_URL,
} from "@/lib/ingest/qoder-plugin-release"

const QODER_COMPONENTS = [
  "qoder_setup.mjs",
  "qoder_token_usage_env.mjs",
  "qoder_trace_collector.mjs",
  "qoder_uploader_client.mjs",
  "qoder_work_setup.mjs",
]

function frameworkValues(script: string): string[] {
  const start = script.indexOf("const frameworks = [")
  assert.notEqual(start, -1, "generated installer must contain the framework selector")
  const end = script.indexOf("];", start)
  assert.notEqual(end, -1, "generated installer must terminate the framework selector")
  return [...script.slice(start, end).matchAll(/value: '([^']+)'/g)].map((match) => match[1])
}

function assertGeneratedScriptSyntax(script: string, platform: "windows" | "unix"): void {
  // The legacy PowerShell generator contains unrelated mojibake strings that the
  // Windows parser rejects. Keep this regression check focused on Bash syntax;
  // the PowerShell Qoder block is asserted structurally below.
  if (platform === "windows") return

  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr || result.stdout)
}

async function setupScript(platform: "windows" | "unix"): Promise<string> {
  const response = await getSetup(new Request("http://localhost/api/ingest/setup?yes=1&frameworks=qoder&key=test-key", {
    headers: { "x-platform": platform, host: "localhost:3000" },
  }))
  assert.equal(response.status, 200)
  return response.text()
}

async function autoSetupScript(platform: "windows" | "unix"): Promise<string> {
  const response = await getAutoSetup(new Request("http://localhost/api/ingest/setup/auto?apiKey=test-key&host=localhost%3A3000", {
    headers: { "x-platform": platform, host: "localhost:3000" },
  }))
  assert.equal(response.status, 200)
  return response.text()
}

test("Qoder setup components are served from an explicit allowlist", async () => {
  for (const component of QODER_COMPONENTS) {
    const response = await getSetup(new Request(`http://localhost/api/ingest/setup?component=${component}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8")
    assert.equal(await response.text(), fs.readFileSync(path.join(process.cwd(), "scripts", component), "utf8"))
  }

  const rejected = await getSetup(new Request("http://localhost/api/ingest/setup?component=..%2Fpackage.json"))
  assert.equal(rejected.status, 404)
})

test("Qoder Desktop VSIX is built from source and served from the source-mtime cache", async () => {
  const info = await getQoderPluginPackageBuildInfo("desktop")
  fs.rmSync(info.cachePath, { force: true })

  try {
    const response = await getQoderDesktopVsix()
    const actual = Buffer.from(await response.arrayBuffer())
    const archive = new AdmZip(actual)
    const entries = new Set(archive.getEntries().map((entry) => entry.entryName))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "application/octet-stream")
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="${info.filename}"`)
    assert.equal(response.headers.get("content-length"), String(actual.byteLength))
    assert.equal(response.headers.get("x-content-type-options"), "nosniff")
    assert.ok(entries.has("extension.vsixmanifest"))
    assert.ok(entries.has("extension/package.json"))
    assert.ok(entries.has("extension/extension.js"))
    assert.ok(entries.has("extension/collector/qoder_trace_collector.mjs"))
    assert.ok(entries.has("extension/collector/qoder_uploader_client.mjs"))
    assert.equal(fs.existsSync(info.cachePath), true)
    assert.ok(fs.statSync(info.cachePath).mtimeMs >= info.sourceMtimeMs)
  } finally {
    fs.rmSync(info.cachePath, { force: true })
  }
})

test("Qoder JetBrains download serves only a compiled plugin ZIP cached by source mtime", async () => {
  const info = await getQoderPluginPackageBuildInfo("jetbrains")
  fs.mkdirSync(path.dirname(info.cachePath), { recursive: true })
  fs.rmSync(info.cachePath, { force: true })

  try {
    const compiledJar = new AdmZip()
    compiledJar.addFile(
      "META-INF/plugin.xml",
      Buffer.from("<idea-plugin><id>org.openeuler.agentinsight.qoder.jetbrains</id></idea-plugin>"),
    )
    const pluginArchive = new AdmZip()
    pluginArchive.addFile(
      "agent-insight-qoder-jetbrains/lib/agent-insight-qoder-jetbrains.jar",
      compiledJar.toBuffer(),
    )
    pluginArchive.writeZip(info.cachePath)
    const freshTime = new Date(info.sourceMtimeMs + 1_000)
    fs.utimesSync(info.cachePath, freshTime, freshTime)

    const response = await getQoderJetBrainsPlugin()
    const actual = Buffer.from(await response.arrayBuffer())
    const archive = new AdmZip(actual)
    const jarEntry = archive.getEntry(
      "agent-insight-qoder-jetbrains/lib/agent-insight-qoder-jetbrains.jar",
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "application/zip")
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="${info.filename}"`)
    assert.equal(response.headers.get("content-length"), String(actual.byteLength))
    assert.equal(response.headers.get("x-content-type-options"), "nosniff")
    assert.ok(jarEntry, "JetBrains package must contain a compiled plugin JAR")
    assert.ok(new AdmZip(jarEntry!.getData()).getEntry("META-INF/plugin.xml"))
  } finally {
    fs.rmSync(info.cachePath, { force: true })
  }
})

test("Qoder JetBrains download can use a configured Release attachment without a build environment", async () => {
  const info = await getQoderPluginPackageBuildInfo("jetbrains")
  const compiledJar = new AdmZip()
  compiledJar.addFile(
    "META-INF/plugin.xml",
    Buffer.from("<idea-plugin><id>org.openeuler.agentinsight.qoder.jetbrains</id></idea-plugin>"),
  )
  const pluginArchive = new AdmZip()
  pluginArchive.addFile(
    "agent-insight-qoder-jetbrains/lib/agent-insight-qoder-jetbrains.jar",
    compiledJar.toBuffer(),
  )
  const releasePackage = pluginArchive.toBuffer()
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Length": String(releasePackage.byteLength),
      "Content-Type": "application/zip",
    })
    response.end(releasePackage)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const previousPackageUrl = process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL
  fs.rmSync(info.cachePath, { force: true })

  try {
    process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL =
      `http://127.0.0.1:${address.port}/agent-insight-qoder-jetbrains.zip`

    const response = await getQoderJetBrainsPlugin()
    const actual = Buffer.from(await response.arrayBuffer())

    assert.equal(response.status, 200)
    assert.deepEqual(actual, releasePackage)
    assert.deepEqual(fs.readFileSync(info.cachePath), releasePackage)
  } finally {
    if (previousPackageUrl === undefined) {
      delete process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL
    } else {
      process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL = previousPackageUrl
    }
    fs.rmSync(info.cachePath, { force: true })
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test("Qoder JetBrains download returns an actionable 503 without a usable Release or build environment", async () => {
  const info = await getQoderPluginPackageBuildInfo("jetbrains")
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-no-java-"))
  const previousPath = process.env.PATH
  const previousJetBrainsHome = process.env.JETBRAINS_HOME
  const previousPackageUrl = process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL
  const previousConsoleError = console.error
  fs.rmSync(info.cachePath, { force: true })

  try {
    process.env.PATH = emptyPath
    delete process.env.JETBRAINS_HOME
    process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL = "file:///not-a-release.zip"
    console.error = () => {}

    const response = await getQoderJetBrainsPlugin()

    assert.equal(response.status, 503)
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8")
    assert.equal(
      await response.text(),
      "Qoder JetBrains plugin build requires JETBRAINS_HOME or a Java/Gradle build environment",
    )
    assert.equal(fs.existsSync(info.cachePath), false)
  } finally {
    console.error = previousConsoleError
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousJetBrainsHome === undefined) delete process.env.JETBRAINS_HOME
    else process.env.JETBRAINS_HOME = previousJetBrainsHome
    if (previousPackageUrl === undefined) delete process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL
    else process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL = previousPackageUrl
    fs.rmSync(info.cachePath, { force: true })
    fs.rmSync(emptyPath, { recursive: true, force: true })
  }
})

test("Qoder plugin builders expose platform-neutral Node and shell entry points", () => {
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  )
  assert.ok(packageManifest.files.includes("integrations/qoder-desktop/build-vsix.mjs"))
  assert.ok(packageManifest.files.includes("integrations/qoder-desktop/extension.js"))
  assert.ok(packageManifest.files.includes("integrations/qoder-jetbrains/build-plugin.mjs"))
  assert.ok(packageManifest.files.includes("integrations/qoder-jetbrains/src/"))
  assert.equal(
    packageManifest.files.some((entry: string) => entry.includes("/build/")),
    false,
    "npm package must not include precompiled plugin artifacts",
  )

  const builders = [
    {
      root: "qoder-desktop",
      script: "build-vsix.mjs",
      expected: /Usage: node build-vsix\.mjs/,
    },
    {
      root: "qoder-jetbrains",
      script: "build-plugin.mjs",
      expected: /JBR compiler[\s\S]*Gradle buildPlugin/,
    },
  ]

  for (const builder of builders) {
    const integrationRoot = path.join(process.cwd(), "integrations", builder.root)
    const nodeResult = spawnSync(
      process.execPath,
      [path.join(integrationRoot, builder.script), "--help"],
      { encoding: "utf8" },
    )
    assert.equal(nodeResult.status, 0, nodeResult.stderr || nodeResult.stdout)
    assert.match(nodeResult.stdout, builder.expected)

    const shellScript = path.join(
      integrationRoot,
      builder.root === "qoder-desktop" ? "build-vsix.sh" : "build-plugin.sh",
    )
    const shellResult = spawnSync("bash", ["-n", shellScript], { encoding: "utf8" })
    assert.equal(shellResult.status, 0, shellResult.stderr || shellResult.stdout)
  }

  const jetBrainsBuilder = fs.readFileSync(
    path.join(process.cwd(), "integrations", "qoder-jetbrains", "build-plugin.mjs"),
    "utf8",
  )
  assert.match(jetBrainsBuilder, /javac/)
  assert.match(jetBrainsBuilder, /buildPlugin/)
  assert.doesNotMatch(jetBrainsBuilder, /src\/main\/java[\s\S]*writeZip/)
})

test("install guide hides Qoder while the setup API keeps Qoder compatibility", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "app", "(main)", "accessconfig", "install", "page.tsx"),
    "utf8",
  )

  assert.doesNotMatch(source, /Qoder CN product family/)
  assert.doesNotMatch(source, /FRAMEWORK_OPTIONS/)
  assert.match(source, /frameworks=actrail/)
})

test("curl setup appends Qoder without changing existing framework entries", async () => {
  for (const platform of ["unix", "windows"] as const) {
    const script = await setupScript(platform)
    assertGeneratedScriptSyntax(script, platform)
    assert.deepEqual(frameworkValues(script), ["opencode", "openclaw", "claude", "codeagent", "hermes", "jiuwen", "qoder", "actrail"])
    assert.match(script, /INSTALL_QODER/)
    assert.match(script, /qoder_setup\.mjs/)
    assert.match(script, /qoder_token_usage_env\.mjs/)
    assert.match(script, /qoder_work_setup\.mjs/)
    assert.match(script, /--product=cli/)
    assert.match(script, /--product=desktop/)
    assert.match(script, /--product=jetbrains/)
    assert.match(script, /\/api\/ingest\/setup\/qoder-desktop-vsix/)
    assert.match(script, /\/api\/ingest\/setup\/qoder-jetbrains-plugin/)
    assert.match(script, /packages[\\\\/]qoder/)
    assert.match(script, /agent-insight-qoder-desktop\.vsix/)
    assert.match(script, /agent-insight-qoder-jetbrains\.zip/)
    assert.match(script, platform === "unix" ? /curl -fsSL/ : /Invoke-WebRequest/)
    assert.match(script, /Release attachment direct URL/)
    assert.match(script, /AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL/)
    assert.match(script, /JetBrains package path/)
    assert.match(script, /Install from VSIX/)
    assert.match(script, /Install Plugin from Disk/)
  }
})

test("local npm auto setup appends Qoder without changing existing framework entries", async () => {
  for (const platform of ["unix", "windows"] as const) {
    const script = await autoSetupScript(platform)
    assertGeneratedScriptSyntax(script, platform)
    assert.deepEqual(frameworkValues(script), ["opencode", "claude", "codeagent", "hermes", "openclaw", "jiuwen", "qoder", "actrail"])
    assert.match(script, /INSTALL_QODER/)
    assert.match(script, /qoder_setup\.mjs/)
    assert.match(script, /qoder_token_usage_env\.mjs/)
    assert.match(script, /qoder_work_setup\.mjs/)
    assert.match(script, /--product=cli/)
    assert.match(script, /--product=desktop/)
    assert.match(script, /--product=jetbrains/)
    assert.match(script, /\/api\/ingest\/setup\/qoder-desktop-vsix/)
    assert.match(script, /\/api\/ingest\/setup\/qoder-jetbrains-plugin/)
    assert.match(script, /packages[\\\\/]qoder/)
    assert.match(script, /agent-insight-qoder-desktop\.vsix/)
    assert.match(script, /agent-insight-qoder-jetbrains\.zip/)
    assert.match(script, platform === "unix" ? /curl -fsSL/ : /Invoke-WebRequest/)
    assert.match(script, /Release attachment direct URL/)
    assert.match(script, /AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL/)
    assert.match(script, /JetBrains package path/)
    assert.match(script, /Install from VSIX/)
    assert.match(script, /Install Plugin from Disk/)
  }
})

test("Qoder setup embeds the configured Release attachment fallback and manual download command", async () => {
  const previousPackageUrl = process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL
  const releaseUrl = "https://releases.example.test/qoder/agent-insight-qoder-jetbrains.zip"

  try {
    process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL = releaseUrl

    for (const generate of [setupScript, autoSetupScript]) {
      for (const platform of ["unix", "windows"] as const) {
        const script = await generate(platform)

        assert.match(script, new RegExp(releaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        assert.match(script, /Retrying from the Release attachment/)
        assert.match(script, platform === "unix" ? /curl -fL/ : /Invoke-WebRequest -Uri/)
        assert.match(script, /agent-insight-qoder-jetbrains\.zip/)
        assert.match(script, /Install Plugin from Disk -> select the ZIP above/)
      }
    }
  } finally {
    if (previousPackageUrl === undefined) {
      delete process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL
    } else {
      process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL = previousPackageUrl
    }
  }
})

test("Qoder setup embeds the built-in JetBrains Release attachment when no override is configured", async () => {
  const previousPackageUrl = process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL

  try {
    delete process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL

    for (const generate of [setupScript, autoSetupScript]) {
      for (const platform of ["unix", "windows"] as const) {
        const script = await generate(platform)
        assert.match(
          script,
          new RegExp(DEFAULT_QODER_JETBRAINS_PACKAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        )
        assert.match(script, /Retrying from the Release attachment/)
      }
    }
  } finally {
    if (previousPackageUrl === undefined) {
      delete process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL
    } else {
      process.env.AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL = previousPackageUrl
    }
  }
})
