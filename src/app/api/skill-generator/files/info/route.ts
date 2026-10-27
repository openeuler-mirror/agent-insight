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

import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { ensureThreadId, getQueryParam, normalizeVirtualPath, resolveWorkspacePath, statFileInfo } from "../utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const threadId = ensureThreadId(req.nextUrl);
    const rawPath = getQueryParam(req.nextUrl, "path");
    if (!rawPath) {
      return NextResponse.json({ error: "Missing required query: path" }, { status: 400 });
    }

    const { absolutePath, virtualPath } = resolveWorkspacePath(threadId, rawPath);
    if (!fs.existsSync(absolutePath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const info = statFileInfo(absolutePath, normalizeVirtualPath(virtualPath));
    return NextResponse.json(info);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

