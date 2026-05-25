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

