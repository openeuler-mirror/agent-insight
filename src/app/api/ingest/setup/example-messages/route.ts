/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
