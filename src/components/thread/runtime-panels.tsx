import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDotDashed,
  Copy,
  Download,
  Eye,
  FileText,
} from "lucide-react";

type TodoValue =
  | string
  | {
      content?: string;
      status?: string;
    };

type FileArtifact = {
  content?: string[] | string;
  created_at?: string;
  modified_at?: string;
};

function toLines(content?: string[] | string): string[] {
  if (!content) return [];
  if (Array.isArray(content)) return content;
  return content.split("\n");
}

function formatTime(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString();
}

function statusIcon(status?: string) {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
    case "done":
    case "success":
      return <CheckCircle2 className="size-4 text-green-600" />;
    case "in_progress":
    case "running":
      return <CircleDotDashed className="size-4 text-amber-600" />;
    default:
      return <Circle className="size-4 text-gray-400" />;
  }
}

function normalizeTodo(todo: TodoValue): { content: string; status?: string } {
  if (typeof todo === "string") return { content: todo };
  return { content: todo.content ?? "", status: todo.status };
}

export function TodoPanel({ todos }: { todos?: TodoValue[] }) {
  const [expanded, setExpanded] = useState(true);
  const normalized = (todos ?? [])
    .map(normalizeTodo)
    .filter((item) => item.content.trim().length > 0);

  if (!normalized.length) return null;

  return (
    <div className="sticky top-0 z-10 rounded-lg border bg-white/95 p-3 backdrop-blur">
      <button
        className="flex w-full cursor-pointer items-center justify-between text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-sm font-semibold text-gray-900">Todo</span>
        {expanded ? (
          <ChevronUp className="size-4 text-gray-500" />
        ) : (
          <ChevronDown className="size-4 text-gray-500" />
        )}
      </button>
      {expanded && (
        <div className="mt-2 flex flex-col gap-2">
          {normalized.map((item, index) => (
            <div
              key={`${item.content}-${index}`}
              className="flex items-start gap-2 text-sm text-gray-700"
            >
              {statusIcon(item.status)}
              <span className="leading-6">{item.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function FileArtifactsPanel({
  files,
}: {
  files?: Record<string, FileArtifact>;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const entries = useMemo(() => {
    return Object.entries(files ?? {}).sort(([, a], [, b]) => {
      const aTime = a.modified_at ? new Date(a.modified_at).getTime() : 0;
      const bTime = b.modified_at ? new Date(b.modified_at).getTime() : 0;
      return bTime - aTime;
    });
  }, [files]);

  if (!entries.length) return null;

  const selected = selectedPath ? files?.[selectedPath] : undefined;
  const selectedLines = toLines(selected?.content);
  const selectedText = selectedLines.join("\n");

  return (
    <>
      <div className="mt-2 flex flex-col gap-3">
        {entries.map(([path, artifact]) => {
          const lines = toLines(artifact.content);
          const filename = path.split("/").pop() || path;
          const directory = path.slice(0, path.length - filename.length);
          const preview = lines.slice(0, 5).join("\n");
          const fullText = lines.join("\n");
          return (
            <div
              key={path}
              className="rounded-lg border bg-white p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <FileText className="size-4 text-sky-600" />
                    <p className="text-sm font-semibold text-gray-900">{filename}</p>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{directory || "/"}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    Updated {formatTime(artifact.modified_at)} · {lines.length} lines
                  </p>
                </div>
              </div>

              <pre className="mt-3 max-h-32 overflow-hidden rounded-md bg-gray-50 p-3 text-xs text-gray-700">
                {preview || "(empty file)"}
              </pre>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(fullText)}
                >
                  <Copy className="size-4" />
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadTextFile(filename, fullText)}
                >
                  <Download className="size-4" />
                  Download
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedPath(path)}
                >
                  <Eye className="size-4" />
                  View Full
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <Sheet
        open={!!selectedPath}
        onOpenChange={(open: boolean) => {
          if (!open) setSelectedPath(null);
        }}
      >
        <SheetContent className="w-full max-w-2xl sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{selectedPath?.split("/").pop() || "File"}</SheetTitle>
            <SheetDescription>{selectedPath}</SheetDescription>
          </SheetHeader>
          <div className="h-full overflow-auto px-4 pb-6">
            <pre className="rounded-md bg-gray-50 p-4 text-xs leading-5 text-gray-800 whitespace-pre-wrap">
              {selectedText || "(empty file)"}
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
