'use client';

// 证据渲染小组件：默认折叠单行预览，点击展开后按内容格式自动渲染
// （{md} → 轻量 Markdown：**粗体** / `code` / - 列表；{json} → 缩进代码块）。
// 界面不展示格式徽章——格式由字段自识别（与 eval-output.ts 的 Evidence 契约一致）。
import { useState, type ReactNode } from 'react';

interface EvidenceLike {
  md?: string;
  json?: unknown;
}

function coerce(evidence: unknown): EvidenceLike | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const r = evidence as Record<string, unknown>;
  if (typeof r.md === 'string' && r.md.trim()) return { md: r.md };
  if ('json' in r && r.json !== undefined && r.json !== null) return { json: r.json };
  return null;
}

/** 行内轻量 Markdown：**粗体** 与 `code`。 */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
      return <b key={i}>{p.slice(2, -2)}</b>;
    }
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      return (
        <code
          key={i}
          style={{
            fontFamily: 'var(--font-mono, monospace)', fontSize: '0.92em',
            background: 'var(--background-secondary)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '0 4px',
          }}
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    return p;
  });
}

/** 轻量 Markdown 块级渲染：段落 + - 列表（参考高保真 mdRender，不引第三方库）。 */
function renderMd(md: string): ReactNode {
  const lines = md.split('\n');
  const blocks: ReactNode[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (!listBuf.length) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} style={{ margin: '4px 0', paddingLeft: 17 }}>
        {listBuf.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
      </ul>,
    );
    listBuf = [];
  };
  for (const line of lines) {
    if (line.startsWith('- ')) {
      listBuf.push(line.slice(2));
      continue;
    }
    flushList();
    if (line.trim()) {
      blocks.push(<p key={`p-${blocks.length}`} style={{ margin: '3px 0' }}>{renderInline(line)}</p>);
    }
  }
  flushList();
  return (
    <div style={{ fontSize: 11.5, lineHeight: 1.65, color: 'var(--foreground-secondary)' }}>
      {blocks}
    </div>
  );
}

function preview(ev: EvidenceLike): string {
  if (ev.md) {
    return ev.md.replace(/[*`#]/g, '').split('\n')
      .map((x) => x.trim().replace(/^-\s*/, '')).filter(Boolean).join('；');
  }
  const j = ev.json;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    return `{ ${Object.keys(j as object).join(' · ')} }`;
  }
  try { return JSON.stringify(j); } catch { return String(j); }
}

export function EvidenceBlock({ evidence }: { evidence: unknown }) {
  const [open, setOpen] = useState(false);
  const ev = coerce(evidence);
  if (!ev) return null;
  return (
    <div
      style={{
        border: '1px solid var(--border)', borderRadius: 7,
        background: 'var(--background-secondary)', overflow: 'hidden',
      }}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 9px',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span
          style={{
            fontSize: 11, color: 'var(--foreground-muted)', lineHeight: 1,
            display: 'inline-block', transition: 'transform .15s',
            transform: open ? 'rotate(90deg)' : 'none',
          }}
        >
          ›
        </span>
        <span
          style={{
            flex: 1, minWidth: 0, fontSize: 11, color: 'var(--foreground-muted)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {preview(ev)}
        </span>
      </div>
      {open && (
        <div style={{ padding: '7px 10px 9px', borderTop: '1px solid var(--border)', background: 'var(--card-bg)' }}>
          {ev.md ? renderMd(ev.md) : (
            <pre
              style={{
                margin: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
                lineHeight: 1.55, color: 'var(--foreground-secondary)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(ev.json, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
