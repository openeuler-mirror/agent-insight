import { readFile } from "node:fs/promises"
import path from "node:path"
import { NextResponse } from "next/server"

const QODER_PLUGIN_PACKAGES = {
  desktop: {
    filename: "agent-insight-qoder-desktop-0.1.12.vsix",
    contentType: "application/octet-stream",
  },
  jetbrains: {
    filename: "agent-insight-qoder-jetbrains-0.1.9.zip",
    contentType: "application/zip",
  },
} as const

export type QoderPluginPackage = keyof typeof QODER_PLUGIN_PACKAGES

export async function serveQoderPluginPackage(kind: QoderPluginPackage): Promise<NextResponse> {
  const pluginPackage = QODER_PLUGIN_PACKAGES[kind]
  const packagePath = path.join(process.cwd(), "public", "qoder-plugins", pluginPackage.filename)

  try {
    const content = await readFile(packagePath)
    return new NextResponse(new Uint8Array(content), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${pluginPackage.filename}"`,
        "Content-Length": String(content.byteLength),
        "Content-Type": pluginPackage.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch {
    return new NextResponse("Qoder plugin package is unavailable", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    })
  }
}
