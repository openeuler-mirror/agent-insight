import fs from "fs"
import path from "path"
import { NextResponse } from "next/server"

// 客户端上下文补传器脚本的下发入口(安装脚本 curl 到 ~/.agent-insight/)。
export async function GET() {
  const filePath = path.join(process.cwd(), "scripts", "claude_context_uploader.js")
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Uploader not found" }, { status: 404 })
  }
  const content = fs.readFileSync(filePath, "utf-8")
  return new NextResponse(content, {
    headers: { "Content-Type": "text/plain" },
  })
}
