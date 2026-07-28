import { serveQoderPluginPackage } from "@/lib/ingest/qoder-plugin-package"

export const runtime = "nodejs"

export async function GET() {
  return serveQoderPluginPackage("jetbrains")
}
