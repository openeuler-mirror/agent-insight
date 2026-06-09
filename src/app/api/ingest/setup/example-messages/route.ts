import fs from "fs"
import path from "path"
import { NextResponse } from "next/server"

/**
 * 内置示例 messages 日志文件。客户端 `curl .../api/setup | bash` 安装时会把它下载到
 * ~/.agent-insight/example/messages，配合内置「messages 日志分析」数据集 / 示例 trace 使用。
 */
export async function GET() {
  const filePath = path.join(process.cwd(), "public", "example", "messages")
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "example messages log not found" }, { status: 404 })
  }
  const content = fs.readFileSync(filePath, "utf-8")
  return new NextResponse(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
