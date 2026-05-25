import fs from "fs"
import path from "path"
import { NextResponse } from "next/server"

export async function GET() {
  const filePath = path.join(process.cwd(), "scripts", "opencode_uploader_client.js")
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Uploader not found" }, { status: 404 })
  }
  const content = fs.readFileSync(filePath, "utf-8")
  return new NextResponse(content, {
    headers: { "Content-Type": "text/plain" },
  })
}

