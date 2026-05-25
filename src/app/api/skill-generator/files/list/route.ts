import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { ensureThreadId, getQueryParam, listDirectory, resolveWorkspacePath } from "../utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const threadId = ensureThreadId(req.nextUrl);
    const rawPath = getQueryParam(req.nextUrl, "path") || "/workspace";

    const { absolutePath, virtualPath } = resolveWorkspacePath(threadId, rawPath);
    if (!fs.existsSync(absolutePath)) {
      return NextResponse.json({ error: "Path not found" }, { status: 404 });
    }

    const payload = listDirectory(absolutePath, virtualPath);
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

