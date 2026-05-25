import { type ReactNode, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";

function truncateTextByLines(
  text: string,
  previewLines: number,
  previewChars: number,
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  const byLines = lines.length > previewLines;
  const byChars = text.length > previewChars;
  const truncated = byLines || byChars;

  if (!truncated) {
    return { text, truncated: false };
  }

  if (byLines) {
    return {
      text: `${lines.slice(0, previewLines).join("\n")}\n...`,
      truncated: true,
    };
  }

  return {
    text: `${text.slice(0, previewChars)}...`,
    truncated: true,
  };
}

export function ExpandableBlock({
  text,
  className,
  previewLines = 10,
  previewChars = 500,
  renderContent,
}: {
  text: string;
  className?: string;
  previewLines?: number;
  previewChars?: number;
  renderContent: (value: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(
    () => truncateTextByLines(text, previewLines, previewChars),
    [text, previewLines, previewChars],
  );
  const value = expanded ? text : preview.text;

  return (
    <div className={className}>
      {renderContent(value)}
      {preview.truncated && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronUp className="size-4" />
              收起
            </>
          ) : (
            <>
              <ChevronDown className="size-4" />
              展开全文
            </>
          )}
        </Button>
      )}
    </div>
  );
}
