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

