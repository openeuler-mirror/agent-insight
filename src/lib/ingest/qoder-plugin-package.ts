import { execFile } from "node:child_process"
import { mkdir, readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"

import { NextResponse } from "next/server"

const execFileAsync = promisify(execFile)

const QODER_PLUGIN_PACKAGES = {
  desktop: {
    contentType: "application/octet-stream",
    integration: "qoder-desktop",
    builder: "build-vsix.mjs",
    versionFile: "package.json",
    filename(version: string) {
      return `agent-insight-qoder-desktop-${version}.vsix`
    },
    readVersion(content: string) {
      return String(JSON.parse(content).version || "").trim()
    },
  },
  jetbrains: {
    contentType: "application/zip",
    integration: "qoder-jetbrains",
    builder: "build-plugin.mjs",
    versionFile: "gradle.properties",
    filename(version: string) {
      return `agent-insight-qoder-jetbrains-${version}.zip`
    },
    readVersion(content: string) {
      return content.match(/^pluginVersion=(.+)$/m)?.[1]?.trim() || ""
    },
  },
} as const

export type QoderPluginPackage = keyof typeof QODER_PLUGIN_PACKAGES

export interface QoderPluginPackageBuildInfo {
  cachePath: string
  contentType: string
  filename: string
  sourceMtimeMs: number
}

const buildPromises = new Map<string, Promise<Buffer>>()

async function latestMtimeMs(targetPath: string): Promise<number> {
  const target = await stat(targetPath)
  if (!target.isDirectory()) return target.mtimeMs

  let latest = target.mtimeMs
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === "build" || entry.name === ".gradle") continue
    latest = Math.max(latest, await latestMtimeMs(path.join(targetPath, entry.name)))
  }
  return latest
}

export async function getQoderPluginPackageBuildInfo(
  kind: QoderPluginPackage,
): Promise<QoderPluginPackageBuildInfo> {
  const definition = QODER_PLUGIN_PACKAGES[kind]
  const repositoryRoot = process.cwd()
  const integrationRoot = path.join(repositoryRoot, "integrations", definition.integration)
  const versionContent = await readFile(path.join(integrationRoot, definition.versionFile), "utf8")
  const version = definition.readVersion(versionContent)
  if (!version) throw new Error(`Unable to resolve the ${kind} plugin version`)

  const filename = definition.filename(version)
  const sourceMtimeMs = Math.max(
    await latestMtimeMs(integrationRoot),
    await latestMtimeMs(path.join(repositoryRoot, "LICENSE")),
    await latestMtimeMs(path.join(repositoryRoot, "scripts", "qoder_trace_collector.mjs")),
    await latestMtimeMs(path.join(repositoryRoot, "scripts", "qoder_uploader_client.mjs")),
    await latestMtimeMs(path.join(repositoryRoot, "scripts", "qoder_setup.mjs")),
    await latestMtimeMs(path.join(repositoryRoot, "scripts", "qoder_token_usage_env.mjs")),
  )

  return {
    cachePath: path.join(repositoryRoot, ".next", "cache", "qoder-plugins", filename),
    contentType: definition.contentType,
    filename,
    sourceMtimeMs,
  }
}

async function readFreshCache(info: QoderPluginPackageBuildInfo): Promise<Buffer | null> {
  try {
    const cached = await stat(info.cachePath)
    if (cached.isFile() && cached.mtimeMs >= info.sourceMtimeMs) {
      return readFile(info.cachePath)
    }
  } catch {}
  return null
}

async function buildPackage(
  kind: QoderPluginPackage,
  info: QoderPluginPackageBuildInfo,
): Promise<Buffer> {
  const cached = await readFreshCache(info)
  if (cached) return cached

  const definition = QODER_PLUGIN_PACKAGES[kind]
  const builderPath = path.join(
    process.cwd(),
    "integrations",
    definition.integration,
    definition.builder,
  )
  await mkdir(path.dirname(info.cachePath), { recursive: true })
  await execFileAsync(process.execPath, [builderPath, "--output", info.cachePath], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: kind === "jetbrains" ? 10 * 60_000 : 60_000,
    windowsHide: true,
  })
  return readFile(info.cachePath)
}

async function resolvePackage(kind: QoderPluginPackage): Promise<{
  content: Buffer
  info: QoderPluginPackageBuildInfo
}> {
  const info = await getQoderPluginPackageBuildInfo(kind)
  const cacheKey = `${kind}:${info.filename}:${info.sourceMtimeMs}`
  let pending = buildPromises.get(cacheKey)
  if (!pending) {
    for (const key of buildPromises.keys()) {
      if (key.startsWith(`${kind}:`)) buildPromises.delete(key)
    }
    pending = buildPackage(kind, info)
    buildPromises.set(cacheKey, pending)
  }

  try {
    return { content: await pending, info }
  } catch (error) {
    buildPromises.delete(cacheKey)
    throw error
  }
}

export async function serveQoderPluginPackage(kind: QoderPluginPackage): Promise<NextResponse> {
  try {
    const { content, info } = await resolvePackage(kind)
    return new NextResponse(new Uint8Array(content), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${info.filename}"`,
        "Content-Length": String(content.byteLength),
        "Content-Type": info.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    console.error(`[qoder-plugin-package] ${kind} build failed:`, error)
    const message = kind === "jetbrains"
      ? "Qoder JetBrains plugin build requires JETBRAINS_HOME or a Java/Gradle build environment"
      : "Qoder Desktop VSIX could not be built from source"
    return new NextResponse(message, {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    })
  }
}
