import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import AdmZip from "adm-zip"
import { isolatedHomeEnv } from './helpers/isolated-home'

import { GET as getInstaller } from "@/app/api/ingest/setup/pi-agent/route"
import { GET as getAsset } from "@/app/api/ingest/setup/pi-agent/assets/[asset]/route"

const require = createRequire(import.meta.url)
const { isSupportedPiVersion } = require("../scripts/agent-trace-collectors/pi-agent/install.cjs")

const BUNDLE_ENTRIES = [
  "goal-plus/goal-plus-collector.cjs",
  "goal-plus/install.cjs",
  "goal-plus/lib/gp-snapshot-parser.cjs",
  "goal-plus/lib/pi-native-parser.cjs",
  "goal-plus/lib/source-registry.cjs",
  "goal-plus/uninstall.cjs",
  "pi-agent/extensions/pi-agent-insight.ts",
  "pi-agent/install.cjs",
  "pi-agent/lib/pi-trace-core.cjs",
  "pi-agent/package.json",
  "pi-agent/scripts/self-check.cjs",
  "pi-agent/scripts/uninstall.cjs",
  "shared/collaboration-transport.cjs",
  "shared/install-modules.cjs",
  "shared/pi-trace-helpers.cjs",
  "shared/trace-transport.cjs",
]

test("Pi installer is self-contained, version-gated, and does not put secrets in asset URLs", async () => {
  const response = await getInstaller(new Request("https://insight.example/api/ingest/setup/pi-agent"))
  const source = await response.text()
  assert.equal(response.status, 200)
  assert.match(source, /Node\.js.*>=22\.19\.0/)
  assert.match(source, /AGENT_INSIGHT_API_KEY/)
  assert.match(source, /install\.cjs/)
  assert.match(source, /--source-dir/)
  assert.match(source, /AGENT_INSIGHT_BASE_URL:-https:\/\/insight\.example/)
  assert.match(source, /BUNDLE_URL="\$BASE_URL\/api\/ingest\/setup\/pi-agent\/assets\/pi-agent-bundle\.zip"/)
  assert.match(source, /EXPECTED_BUNDLE_SHA256="[0-9a-f]{64}"/)
  assert.ok(source.indexOf("ACTUAL_BUNDLE_SHA256") < source.indexOf("unzip -q"))
  assert.ok(source.indexOf("unzip -q") < source.indexOf('node "$STAGE_DIR/pi-agent/install.cjs"'))
  assert.doesNotMatch(source, /apiKey=/)
  assert.doesNotMatch(source, /github\.com/)
})

test("Pi setup route returns the PowerShell staging installer for Windows", async () => {
  const response = await getInstaller(new Request(
    "https://insight.example/api/ingest/setup/pi-agent",
    { headers: { "x-platform": "windows" } },
  ))
  const source = await response.text()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "application/x-powershell; charset=utf-8")
  assert.match(source, /install\.cjs/)
  assert.match(source, /Invoke-WebRequest/)
  assert.match(source, /pi-agent-bundle\.zip/)
  assert.match(source, /Get-FileHash/)
  assert.match(source, /Expand-Archive/)
  assert.match(source, /--source-dir/)
  assert.ok(source.indexOf("Get-FileHash") < source.indexOf("Expand-Archive"))
  assert.ok(source.indexOf("Expand-Archive") < source.indexOf("& node"))
  assert.doesNotMatch(source, /apiKey=/)
})

test("Pi setup route escapes forwarded origins before embedding them in shell scripts", async () => {
  for (const platform of ["unix", "windows"] as const) {
    const response = await getInstaller(new Request(
      "https://insight.example/api/ingest/setup/pi-agent",
      {
        headers: {
          "x-platform": platform,
          "x-forwarded-proto": "https",
          "x-forwarded-host": "insight.example$(touch PWN)\"`$HOME",
        },
      },
    ))
    const source = await response.text()
    assert.equal(response.status, 200)
    assert.match(
      source,
      platform === "windows"
        ? /insight\.example`\$\(touch PWN\)`"/
        : /insight\.example\\\$\(touch PWN\)\\"\\`\\\$HOME/,
    )
  }
})

test("Pi setup serves one complete bundle whose SHA-256 matches the bootstrap", async () => {
  const installerResponse = await getInstaller(new Request("https://insight.example/api/ingest/setup/pi-agent"))
  const installer = await installerResponse.text()
  const expectedDigest = /EXPECTED_BUNDLE_SHA256="([0-9a-f]{64})"/.exec(installer)?.[1]
  assert.ok(expectedDigest, "bootstrap must embed a concrete bundle digest")

  const response = await getAsset(
    new Request("https://insight.example/assets/pi-agent-bundle.zip"),
    { params: Promise.resolve({ asset: "pi-agent-bundle.zip" }) },
  )
  const bundle = Buffer.from(await response.arrayBuffer())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "application/zip")
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
  assert.equal(createHash("sha256").update(bundle).digest("hex"), expectedDigest)
  assert.deepEqual(
    new AdmZip(bundle).getEntries().map((entry) => entry.entryName).sort(),
    BUNDLE_ENTRIES,
  )

  for (const oldAsset of ["install.cjs", "pi-trace-core.cjs", "trace-transport.cjs"]) {
    const legacy = await getAsset(
      new Request(`https://insight.example/assets/${oldAsset}`),
      { params: Promise.resolve({ asset: oldAsset }) },
    )
    assert.equal(legacy.status, 200, oldAsset)
    assert.equal(legacy.headers.get("deprecation"), "true", oldAsset)
  }

  const denied = await getAsset(
    new Request("https://insight.example/assets/../../package.json"),
    { params: Promise.resolve({ asset: "../../package.json" }) },
  )
  assert.equal(denied.status, 404)
  const prototypeAsset = await getAsset(
    new Request("https://insight.example/assets/constructor"),
    { params: Promise.resolve({ asset: "constructor" }) },
  )
  assert.equal(prototypeAsset.status, 404)
})

test("Pi installer writes one identity and endpoint set for main and Goal Plus traces", (t) => {
  if (process.platform === "win32") return t.skip("Unix launcher fixture is not used on Windows")
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-pi-install-"))
  const homeDir = path.join(tempDir, "user")
  const agentInsightHome = path.join(tempDir, "agent-insight")
  const binDir = path.join(tempDir, "bin")
  const piPath = path.join(binDir, "pi")
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(piPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'pi 0.82.1'; fi",
    `if [ "$1" = "install" ]; then node -e 'const f=require("fs"),p=require("path"); f.mkdirSync(process.env.PI_CODING_AGENT_DIR,{recursive:true}); f.writeFileSync(p.join(process.env.PI_CODING_AGENT_DIR,"settings.json"),JSON.stringify({packages:[process.argv[1]]}));' "$2"; fi`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o700 })
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  const sourceDir = path.join(process.cwd(), "scripts", "agent-trace-collectors", "pi-agent")
  const result = spawnSync(process.execPath, [
    path.join(sourceDir, "install.cjs"),
    "--home", homeDir,
    "--source-dir", sourceDir,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_INSIGHT_API_KEY: "same-account-key",
      AGENT_INSIGHT_BASE_URL: "https://insight.example",
      AGENT_INSIGHT_HOME: agentInsightHome,
      AGENT_INSIGHT_PI_ENDPOINT: "https://insight.example/main-traces",
      AGENT_INSIGHT_PI_COLLABORATION_SESSIONS_ENDPOINT: "https://insight.example/sessions",
      AGENT_INSIGHT_PI_COLLABORATION_EVENTS_ENDPOINT: "https://insight.example/events",
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const piConfig = JSON.parse(fs.readFileSync(path.join(agentInsightHome, "collectors", "pi-agent", "config.json"), "utf8"))
  const goalPlusConfig = JSON.parse(fs.readFileSync(path.join(agentInsightHome, "collectors", "goal-plus", "config.json"), "utf8"))
  assert.equal(goalPlusConfig.apiKey, piConfig.apiKey)
  assert.equal(goalPlusConfig.otlpEndpoint, piConfig.endpoint)
  assert.equal(goalPlusConfig.collaborationSessionsEndpoint, piConfig.collaborationSessionsEndpoint)
  assert.equal(goalPlusConfig.collaborationEventsEndpoint, piConfig.collaborationEventsEndpoint)
})

test("PowerShell bootstrap rejects a tampered Pi bundle before installation", async (t) => {
  const bundleResponse = await getAsset(
    new Request("https://insight.example/assets/pi-agent-bundle.zip"),
    { params: Promise.resolve({ asset: "pi-agent-bundle.zip" }) },
  )
  const tamperedBundle = Buffer.from(await bundleResponse.arrayBuffer())
  tamperedBundle[tamperedBundle.length - 1] ^= 0xff

  const server = http.createServer((request, response) => {
    if (request.url === "/api/ingest/setup/pi-agent/assets/pi-agent-bundle.zip") {
      response.writeHead(200, { "content-type": "application/zip" })
      response.end(tamperedBundle)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  const installerResponse = await getInstaller(new Request(
    `${origin}/api/ingest/setup/pi-agent`,
    { headers: { "x-platform": "windows" } },
  ))
  const installer = await installerResponse.text()

  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const encodedInstaller = Buffer.from(installer, "utf16le").toString("base64")
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedInstaller], {
      env: { ...process.env, AGENT_INSIGHT_API_KEY: "test-pi-key" },
      windowsHide: true,
    })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, output }))
  })

  assert.notEqual(result.code, 0, result.output)
  assert.match(result.output, /bundle SHA-256 mismatch/)
  assert.doesNotMatch(result.output, /collector installed/)
})

test("PowerShell bootstrap installs a valid Pi bundle end to end", async (t) => {
  const bundleResponse = await getAsset(
    new Request("https://insight.example/assets/pi-agent-bundle.zip"),
    { params: Promise.resolve({ asset: "pi-agent-bundle.zip" }) },
  )
  const bundle = Buffer.from(await bundleResponse.arrayBuffer())
  const server = http.createServer((request, response) => {
    if (request.url === "/api/ingest/setup/pi-agent/assets/pi-agent-bundle.zip") {
      response.writeHead(200, { "content-type": "application/zip" })
      response.end(bundle)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  const installerResponse = await getInstaller(new Request(
    `${origin}/api/ingest/setup/pi-agent`,
    { headers: { "x-platform": "windows" } },
  ))
  const installer = await installerResponse.text()

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-pi-e2e-"))
  const homeDir = path.join(tempDir, "user")
  const agentInsightHome = path.join(tempDir, "agent-insight")
  const binDir = path.join(tempDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, "pi-stub.cjs"), `
    const fs = require('fs'), path = require('path');
    if (process.argv[2] === '--version') console.log('pi 0.82.1');
    if (process.argv[2] === 'install') {
      fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ packages: [process.argv[3]] }));
    }
  `)
  fs.writeFileSync(
    path.join(binDir, "pi.cmd"),
    '@echo off\r\nnode "%~dp0pi-stub.cjs" %*\r\nexit /b %errorlevel%\r\n',
  )
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const encodedInstaller = Buffer.from(installer, "utf16le").toString("base64")
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedInstaller], {
      env: {
        ...process.env,
        AGENT_INSIGHT_API_KEY: "test-pi-key",
        AGENT_INSIGHT_BASE_URL: origin,
        AGENT_INSIGHT_HOME: agentInsightHome,
        HOME: homeDir,
        USERPROFILE: homeDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      },
      windowsHide: true,
    })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, output }))
  })
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /collector installed/)
  assert.equal(fs.existsSync(path.join(agentInsightHome, "collectors", "pi-agent", "extensions", "pi-agent-insight.ts")), true)
  assert.equal(fs.existsSync(path.join(agentInsightHome, "collectors", "pi-agent", "config.json")), true)
  assert.equal(fs.existsSync(path.join(agentInsightHome, "collectors", "goal-plus", "goal-plus-collector.cjs")), true)
  const piConfig = JSON.parse(fs.readFileSync(path.join(agentInsightHome, "collectors", "pi-agent", "config.json"), "utf8"))
  assert.equal(piConfig.goalPlusObserverEnabled, true)
  const goalPlusConfig = JSON.parse(fs.readFileSync(path.join(agentInsightHome, "collectors", "goal-plus", "config.json"), "utf8"))
  assert.equal(goalPlusConfig.managedBy, "pi-agent")
  assert.equal(goalPlusConfig.apiKey, piConfig.apiKey)
  assert.equal(goalPlusConfig.otlpEndpoint, piConfig.endpoint)
  assert.equal(goalPlusConfig.collaborationSessionsEndpoint, piConfig.collaborationSessionsEndpoint)
  assert.equal(goalPlusConfig.collaborationEventsEndpoint, piConfig.collaborationEventsEndpoint)
  assert.equal(fs.existsSync(path.join(agentInsightHome, "collectors", "shared", "trace-transport.cjs")), true)
})

test("Pi package manifest declares the real Extension entry and an open-ended compatible Pi range", () => {
  const manifestPath = path.join(
    process.cwd(),
    "scripts",
    "agent-trace-collectors",
    "pi-agent",
    "package.json",
  )
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  assert.deepEqual(manifest.pi.extensions, ["./extensions/pi-agent-insight.ts"])
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.82.1")
})

test("Pi installer accepts newer semver releases while rejecting unsupported versions", () => {
  assert.equal(isSupportedPiVersion("pi 0.82.1"), true)
  assert.equal(isSupportedPiVersion("0.82.2-beta.1"), true)
  assert.equal(isSupportedPiVersion("0.83.0"), true)
  assert.equal(isSupportedPiVersion("v1.0.0"), true)
  assert.equal(isSupportedPiVersion("0.82.0"), false)
  assert.equal(isSupportedPiVersion("unknown"), false)
})

test("uninstall script refuses to mutate a source checkout outside the managed package path", () => {
  const script = path.join(
    process.cwd(),
    "scripts",
    "agent-trace-collectors",
    "pi-agent",
    "scripts",
    "uninstall.cjs",
  )
  const result = spawnSync(process.execPath, [script, "--purge"], { encoding: "utf8" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Refusing to remove unexpected collector package path/)
  assert.equal(fs.existsSync(script), true)
})

test("uninstall source scopes deletion to Pi paths and requires purge-all confirmation", () => {
  const source = fs.readFileSync(
    path.join(
      process.cwd(),
      "scripts",
      "agent-trace-collectors",
      "pi-agent",
      "scripts",
      "uninstall.cjs",
    ),
    "utf8",
  )
  assert.match(source, /otel_data", "pi-agent"/)
  assert.match(source, /--purge-all/)
  assert.match(source, /--yes/)
  assert.doesNotMatch(source, /opencode|claude|hermes|codex/)
})

for (const failure of ['registration', 'verification'] as const) {
  test(`Pi upgrade restores installed files, config and registration after ${failure} failure`, t => {
    if (process.platform === 'win32') return t.skip('Unix executable fixture');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rollback-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const home = path.join(temporary, 'home');
    const bin = path.join(temporary, 'bin');
    const source = path.join(temporary, 'source');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['pi-agent', 'goal-plus', 'shared']) {
      fs.cpSync(path.resolve('scripts/agent-trace-collectors', name), path.join(source, name), { recursive: true });
    }
    fs.writeFileSync(path.join(bin, 'pi'), `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const [action,packageDir]=process.argv.slice(2);
if(action==='--version') console.log('pi 0.84.2');
if(action==='install') {
 const directory=process.env.PI_CODING_AGENT_DIR;
 fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify({packages:process.env.FAIL_MODE==='verification'?[]:[packageDir]}));
 if(process.env.FAIL_MODE==='registration') process.exit(7);
}
`, { mode: 0o700 });
    const env = isolatedHomeEnv(home, { PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
      AGENT_INSIGHT_API_KEY: 'synthetic-install', AGENT_INSIGHT_BASE_URL: 'http://127.0.0.1:39999',
      PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    const installer = path.join(source, 'pi-agent/install.cjs');
    const run = (extra: Record<string, string> = {}) => spawnSync(process.execPath, [installer, '--home', home], {
      env: { ...env, ...extra }, encoding: 'utf8',
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const collectors = path.join(home, '.agent-insight/collectors');
    const originals = [
      path.join(collectors, 'pi-agent/lib/pi-trace-core.cjs'),
      path.join(collectors, 'pi-agent/config.json'),
      path.join(collectors, 'pi-agent/installation.json'),
      path.join(collectors, 'goal-plus/config.json'),
      path.join(collectors, 'shared/installation.json'),
      path.join(home, '.pi/agent/settings.json'),
    ].map(file => ({ file, bytes: fs.readFileSync(file) }));
    const pending = path.join(collectors, 'goal-plus/sources.json');
    fs.writeFileSync(pending, '{"version":1,"sources":[]}');
    fs.appendFileSync(path.join(source, 'pi-agent/lib/pi-trace-core.cjs'), '\n// next compatible package\n');
    const failed = run({ FAIL_MODE: failure, AGENT_INSIGHT_API_KEY: 'changed-account' });
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, failure === 'registration' ? /failed/ : /registration verification failed/);
    for (const { file, bytes } of originals) assert.deepEqual(fs.readFileSync(file), bytes, file);
    assert.equal(fs.readFileSync(pending, 'utf8'), '{"version":1,"sources":[]}');
    const retried = run();
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.stdout, /Restart Pi/);
    assert.match(fs.readFileSync(originals[0].file, 'utf8'), /next compatible package/);
  });
}
