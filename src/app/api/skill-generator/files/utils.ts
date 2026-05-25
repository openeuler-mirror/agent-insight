import fs from "fs";
import path from "path";
import { resolveWorkspaceRoot } from "@/lib/engine/skill-generation/supervisor/createSupervisorAgent";

type FileType = "file" | "dir";

export type FileListItem = {
  name: string;
  path: string;
  type: FileType;
  size: number;
  modified_at: string;
};

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".conf": "text/plain",
  ".sh": "text/x-shellscript",
  ".py": "text/x-python",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".tsx": "application/typescript",
  ".jsx": "application/javascript",
  ".sql": "text/plain",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

export function getQueryParam(url: URL, key: string): string {
  return url.searchParams.get(key)?.trim() ?? "";
}

export function ensureThreadId(url: URL): string {
  const threadId = getQueryParam(url, "threadId");
  if (!threadId) {
    throw new Error("Missing required query: threadId");
  }
  return threadId;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function stripWorkspacePrefix(rawVirtualPath: string): string {
  const normalized = rawVirtualPath.replace(/\\/g, "/").trim();
  if (!normalized) return "";
  if (normalized === "/workspace") return "";
  if (normalized.startsWith("/workspace/")) return normalized.slice("/workspace/".length);
  return normalized.replace(/^\/+/, "");
}

export function normalizeVirtualPath(rawVirtualPath: string): string {
  const cleaned = stripWorkspacePrefix(rawVirtualPath);
  return cleaned ? `/workspace/${cleaned}` : "/workspace";
}

export function resolveWorkspacePath(threadId: string, rawVirtualPath: string): {
  workspaceRoot: string;
  absolutePath: string;
  virtualPath: string;
} {
  const workspaceRoot = resolveWorkspaceRoot(threadId);
  const relativePath = stripWorkspacePrefix(rawVirtualPath);
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  const normalizedRoot = path.resolve(workspaceRoot);

  if (absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Invalid path: outside workspace root");
  }

  const virtualPath = relativePath ? `/workspace/${toPosixPath(relativePath)}` : "/workspace";
  return { workspaceRoot: normalizedRoot, absolutePath, virtualPath };
}

export function statFileInfo(absolutePath: string, virtualPath: string) {
  const stat = fs.statSync(absolutePath);
  const ext = path.extname(absolutePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return {
    path: virtualPath,
    name: path.basename(absolutePath),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mimeType,
    modified_at: stat.mtime.toISOString(),
    created_at: stat.birthtime.toISOString(),
  };
}

function isMimeText(mimeType: string): boolean {
  return TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || TEXT_MIME_EXACT.has(mimeType);
}

function hasBinaryNullByte(buffer: Buffer): boolean {
  const max = Math.min(buffer.length, 8000);
  for (let i = 0; i < max; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function readFilePayload(absolutePath: string, virtualPath: string) {
  const meta = statFileInfo(absolutePath, virtualPath);
  if (meta.isDirectory) {
    throw new Error("Path is a directory");
  }

  const raw = fs.readFileSync(absolutePath);
  const isText = isMimeText(meta.mimeType) && !hasBinaryNullByte(raw);
  return {
    ...meta,
    isText,
    encoding: isText ? "utf8" : "base64",
    content: isText ? raw.toString("utf8") : raw.toString("base64"),
  };
}

export function listDirectory(absolutePath: string, virtualPath: string): { path: string; items: FileListItem[] } {
  const stat = fs.statSync(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  const items: FileListItem[] = entries.map((entry) => {
    const full = path.join(absolutePath, entry.name);
    const entryStat = fs.statSync(full);
    const childPath = virtualPath === "/workspace"
      ? `/workspace/${entry.name}`
      : `${virtualPath}/${entry.name}`;
    return {
      name: entry.name,
      path: childPath,
      type: entry.isDirectory() ? "dir" : "file",
      size: entryStat.size,
      modified_at: entryStat.mtime.toISOString(),
    };
  });

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: virtualPath, items };
}

