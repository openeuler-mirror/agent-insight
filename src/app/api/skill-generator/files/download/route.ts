import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { ensureThreadId, getQueryParam, resolveWorkspacePath, statFileInfo } from "../utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const threadId = ensureThreadId(req.nextUrl);
    const rawPath = getQueryParam(req.nextUrl, "path");
    if (!rawPath) {
      return new Response(JSON.stringify({ error: "Missing required query: path" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { absolutePath } = resolveWorkspacePath(threadId, rawPath);
    if (!fs.existsSync(absolutePath)) {
      return new Response(JSON.stringify({ error: "File not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      return new Response(JSON.stringify({ error: "Path is a directory" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const info = statFileInfo(absolutePath, rawPath);
    const filename = path.basename(absolutePath);
    const content = fs.readFileSync(absolutePath);
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": info.mimeType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "Content-Length": String(content.length),
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
}

