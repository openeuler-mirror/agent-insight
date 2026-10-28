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
import { ensureThreadId, getQueryParam, readFilePayload, resolveWorkspacePath } from "../utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PutBody = {
  threadId?: string;
  path?: string;
  content?: string;
  previousModifiedAt?: string;
};

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

    return NextResponse.json(readFilePayload(absolutePath, virtualPath));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as PutBody;
    const threadId = body.threadId?.trim();
    const rawPath = body.path?.trim();
    const content = typeof body.content === "string" ? body.content : "";
    const previousModifiedAt = body.previousModifiedAt?.trim();

    if (!threadId || !rawPath) {
      return NextResponse.json({ error: "Missing required fields: threadId, path" }, { status: 400 });
    }

    const { absolutePath, virtualPath } = resolveWorkspacePath(threadId, rawPath);
    if (!fs.existsSync(absolutePath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      return NextResponse.json({ error: "Path is a directory" }, { status: 400 });
    }

    if (previousModifiedAt && stat.mtime.toISOString() !== previousModifiedAt) {
      return NextResponse.json(
        {
          error: "File has been modified by another process",
          code: "VERSION_CONFLICT",
          modified_at: stat.mtime.toISOString(),
        },
        { status: 409 },
      );
    }

    fs.writeFileSync(absolutePath, content, "utf8");
    const updated = fs.statSync(absolutePath);
    return NextResponse.json({
      path: virtualPath,
      saved: true,
      size: updated.size,
      modified_at: updated.mtime.toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

