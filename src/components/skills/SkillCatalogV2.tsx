'use client';

/**
 * Skill 管理 v2 —— 对齐高保真稿。
 *
 * 第 1 阶段范围：
 *  - 卡片式列表（描述/状态/质量条/引用数/七天内调用/版本 chip）
 *  - 右侧抽屉详情：VersionSwitcher + Overview / History / Content 三个 tab
 *  - 数据来自现有 /api/skills、/api/skills/:id/versions、/api/skills/:id/versions/:v、
 *    /api/skills/:id/versions/:v/evaluation-summary、/api/skills/:id/versions/:v/parse-flow
 *  - 后端缺失的字段（如某版本的 evalIssues 行号、变更 diff、p95 等）优雅降级为 "—"
 *
 * 视觉 token 局部于 `.sk-scope`，不影响其它页。
 */

import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { STATIC_EVAL_STANDARDS } from '@/components/evaluation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { diffLines } from 'diff';
import {
    Background,
    BackgroundVariant,
    Controls,
    Handle,
    MarkerType,
    MiniMap,
    Position,
    ReactFlow,
    type Edge,
    type Node,
    type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';

// ───────── Types ─────────

interface SkillListItem {
    id: string;
    name: string;
    description: string;
    category?: string;
    tags?: string[];
    author?: string;
    updatedAt: string;
    activeVersion: number;
    visibility?: string;
    qualityScore: number; // 1–4
    qualityIssues?: { high: number; medium: number; low: number };
    calls7d?: number;
    agentsUsing?: number;
    successRate: number | null;
    isUploaded?: boolean;
    versions?: Array<{ version: number; createdAt: string; changeLog?: string }>;
}

interface VersionMeta {
    id: string;
    version: number;
    semanticVersion?: string;
    changeLog?: string;
    createdAt: string;
    author?: string | null;
    usage?: { calls7d: number; agents: number; successRate: number | null; p95Latency: number | null };
    trend?: number[];
    executions?: any[];
}

interface VersionDetail {
    content?: string;
    createdAt?: string;
    changeLog?: string;
    files?: string;
}

interface EvalSummary {
    latest: null | {
        evaluationId: string;
        ranAt: string;
        status: string;
        generator: string | null;
        issuesCount: number;
        severityHistogram: { high: number; medium: number; low: number };
        l2Scores?: {
            scores?: Record<string, number>;
            comments?: { meta?: string; code?: string };
        } | null;
    };
    history: Array<{ evaluationId: string; ranAt: string; status: string; issuesCount: number }>;
}

interface AnalysisHealthSummary {
    health: number | null;
    coveredCount: number;
    totalCount: number;
}

interface ParsedFlow {
    parsed: boolean;
    flowJson?: string;
    mermaidCode?: string;
    parsedAt?: string;
}

interface FlowStep {
    id?: string;
    name: string;
    description?: string;
    type?: 'action' | 'decision' | 'output';
}

// ───────── Scoped styles ─────────

const SCOPED_CSS = `
/*
 * .sk-scope —— Skills v2 局部主题，所有 token 都映射到全局 tokens（src/app/globals.css
 * 中的 :root / [data-theme='dark']），亮/暗模式自动跟随侧栏。
 *
 * 历史原因：v2 一开始定义了 Langfuse 风的奶白底（#f6f6f3）独立调色板，结果暗色模式下
 * 侧栏深、主区奶白，撕裂感很强。现在改成映射全局 token + 暗色覆写，跟项目其它页一致。
 */
.sk-scope {
  /* 表面层 */
  --sk-canvas: var(--background);
  --sk-surface: var(--card-bg);
  --sk-elevated: var(--background-secondary);

  /* 描边 */
  --sk-border: var(--border);
  --sk-border-d: var(--border-dark);
  --sk-border-s: var(--border-dark);

  /* 文字 */
  --sk-fg: var(--foreground);
  --sk-fg2: var(--foreground-secondary);
  --sk-fg3: var(--foreground-muted);
  --sk-accent: var(--foreground);

  /* 主色 */
  --sk-primary: var(--primary);
  --sk-primary-deep: var(--primary-hover);
  --sk-primary-soft: var(--primary-subtle);
  --sk-primary-border: var(--primary-subtle-border);

  /* 状态语义 */
  --sk-success: var(--success);
  --sk-success-bg: var(--success-subtle);
  --sk-success-fg: #047857;
  --sk-warning: var(--warning);
  --sk-warning-bg: var(--warning-subtle);
  --sk-warning-fg: #B45309;
  --sk-danger: var(--error);
  --sk-danger-bg: var(--error-subtle);
  --sk-danger-fg: #B91C1C;
  --sk-info: var(--primary);
  --sk-info-bg: var(--primary-subtle);
  --sk-purple: #7c3aed;
  --sk-purple-bg: rgba(124, 58, 237, 0.10);

  /* Lifecycle 顶部条 —— 亮色用最浅的 indigo tint */
  --sk-lifecycle-grad: linear-gradient(135deg, #FAFBFF 0%, #F4F6FF 100%);

  /* 状态点光环 rgba（围绕生命周期节点的 box-shadow） */
  --sk-ring-primary: rgba(79, 70, 229, 0.18);
  --sk-ring-warning: rgba(217, 119, 6, 0.18);
  --sk-ring-danger:  rgba(220, 38, 38, 0.15);

  background: var(--sk-canvas);
  color: var(--sk-fg);
  font-family: 'Manrope', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}

[data-theme='dark'] .sk-scope {
  /* 暗模式下徽章/数字气泡里的"绿/黄/红文字"在低饱和半透明底上要更亮才看得清 */
  --sk-success-fg: #86EFAC;  /* green-300 */
  --sk-warning-fg: #FDE68A;  /* amber-200 */
  --sk-danger-fg:  #FCA5A5;  /* red-300 */

  /* Lifecycle 渐变换成 indigo 半透明，与 zinc-900 卡片融合 */
  --sk-lifecycle-grad: linear-gradient(135deg, rgba(129, 140, 248, 0.06) 0%, rgba(129, 140, 248, 0.12) 100%);

  /* 暗模式下光环用亮 indigo，可见度更高 */
  --sk-ring-primary: rgba(129, 140, 248, 0.30);
  --sk-ring-warning: rgba(251, 191, 36, 0.30);
  --sk-ring-danger:  rgba(248, 113, 113, 0.30);

  --sk-purple: #C4B5FD;
  --sk-purple-bg: rgba(167, 139, 250, 0.14);
}
.sk-scope .sk-mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
.sk-scope .sk-card { background:var(--sk-surface); border:1px solid var(--sk-border);
  border-radius:12px; box-shadow:0 1px 0 rgba(0,0,0,.02), 0 1px 2px rgba(0,0,0,.03);
  transition: box-shadow .15s ease, transform .15s ease; }
.sk-scope .sk-card:hover { box-shadow:0 1px 0 rgba(0,0,0,.04), 0 4px 12px rgba(0,0,0,.06); }
.sk-scope .sk-pulse { animation: sk-pulse 2s ease-in-out infinite; }
@keyframes sk-pulse { 0%,100% { opacity:1; transform:scale(1);} 50% { opacity:.6; transform:scale(.85);} }
.sk-scope .sk-vchip { transition: background .15s ease, color .15s ease; }
.sk-scope .sk-vchip:hover:not(.on) { background:var(--sk-elevated); }
.sk-scope .sk-vchip.on { background:var(--sk-primary); color:#fff; }
.sk-drawer-overlay { position:fixed; inset:0; background:rgba(15,15,18,.4); z-index:1100; animation: sk-fade .25s ease both; }
.sk-drawer { position:fixed; top:0; right:0; bottom:0; width:920px; max-width:100%;
  background:var(--sk-surface); z-index:1101; display:flex; flex-direction:column;
  box-shadow:-12px 0 32px rgba(0,0,0,.12); animation: sk-slide .35s cubic-bezier(.22,1,.36,1) both; }
@keyframes sk-slide { from { transform:translateX(40px); opacity:0;} to { transform:translateX(0); opacity:1;} }
@keyframes sk-fade  { from { opacity:0;} to { opacity:1;} }
.sk-scope .sk-arrow { position:relative; height:14px; }
.sk-scope .sk-arrow::before { content:''; position:absolute; left:50%; top:-1px; width:1px; height:14px; background:var(--sk-border-s); transform:translateX(-50%); }
.sk-scope .sk-arrow::after { content:''; position:absolute; left:50%; top:9px; width:0; height:0;
  border-left:3px solid transparent; border-right:3px solid transparent; border-top:4px solid var(--sk-border-s); transform:translateX(-50%); }
.sk-scope .sk-fade-in { animation: sk-fadeIn .25s ease both; }
@keyframes sk-fadeIn { from { opacity:0; transform:translateY(4px);} to { opacity:1; transform:translateY(0);} }
.sk-scope .sk-scrollbar::-webkit-scrollbar { width:6px; height:6px; }
.sk-scope .sk-scrollbar::-webkit-scrollbar-thumb { background:var(--sk-border-s); border-radius:3px; }
.sk-scope .sk-tab { border-bottom:2px solid transparent; color:var(--sk-fg3); transition: color .15s ease, border-color .15s ease, background .15s ease; }
.sk-scope .sk-tab:hover { background:var(--sk-elevated); }
.sk-scope .sk-tab.on { border-bottom-color:var(--sk-primary); color:var(--sk-primary); }
.sk-scope .sk-btn-primary { background:var(--sk-primary); color:#fff; border:1px solid var(--sk-primary);
  padding:6px 12px; border-radius:8px; font-size:12px; font-weight:500; cursor:pointer; }
.sk-scope .sk-btn-primary:hover { background:var(--sk-primary-deep); border-color:var(--sk-primary-deep); }
.sk-scope .sk-btn { background:var(--sk-surface); color:var(--sk-fg); border:1px solid var(--sk-border-d);
  padding:6px 12px; border-radius:8px; font-size:12px; font-weight:500; cursor:pointer; }
.sk-scope .sk-btn:hover { background:var(--sk-elevated); }
.sk-scope .sk-btn:disabled { opacity:.4; cursor:not-allowed; }
.sk-scope .sk-input { background:var(--sk-surface); color:var(--sk-fg); border:1px solid var(--sk-border-d); border-radius:8px;
  padding:8px 12px; font-size:12px; outline:none; }
.sk-scope .sk-input::placeholder { color:var(--sk-fg3); }
.sk-scope .sk-input:focus { border-color:var(--sk-primary); box-shadow:0 0 0 3px var(--sk-ring-primary); }
.sk-scope .sk-display { font-family:'Instrument Serif', ui-serif, Georgia, serif; font-weight:400; letter-spacing:-0.01em; }

/* ── Lifecycle Stepper (v1.4 §A.6) ── */
.sk-scope .sk-lifecycle { background: var(--sk-lifecycle-grad);
  border:1px solid var(--sk-primary-border); border-radius:12px; padding:16px 18px; }
.sk-scope .sk-lifecycle-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.sk-scope .sk-lifecycle-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--sk-primary);
  display:inline-flex; align-items:center; gap:6px; }
.sk-scope .sk-lifecycle-progress { font-size:11px; color:var(--sk-fg2); font-family:'JetBrains Mono', ui-monospace, monospace; }
.sk-scope .sk-lifecycle-progress strong { color:var(--sk-primary); font-weight:700; }
.sk-scope .sk-lifecycle-stages { display:flex; align-items:flex-start; gap:0; }
.sk-scope .sk-lc-stage { display:flex; flex-direction:column; align-items:center; gap:6px; flex:1 1 0; min-width:0; position:relative; }
.sk-scope .sk-lc-dot { width:32px; height:32px; border-radius:50%; display:grid; place-items:center;
  font-size:13px; font-weight:700; flex-shrink:0; transition:all 0.2s; line-height:1; }
.sk-scope .sk-lc-stage.done .sk-lc-dot { background:var(--sk-success); color:#fff; }
.sk-scope .sk-lc-stage.current .sk-lc-dot { background:var(--sk-primary); color:#fff; box-shadow:0 0 0 4px var(--sk-ring-primary); }
.sk-scope .sk-lc-stage.warn .sk-lc-dot { background:var(--sk-warning); color:#fff; box-shadow:0 0 0 4px var(--sk-ring-warning); }
.sk-scope .sk-lc-stage.danger .sk-lc-dot { background:var(--sk-danger); color:#fff; box-shadow:0 0 0 4px var(--sk-ring-danger); }
.sk-scope .sk-lc-stage.todo .sk-lc-dot { background:var(--sk-surface); color:var(--sk-fg3); border:1.5px dashed var(--sk-border-s); }
.sk-scope .sk-lc-label { font-size:12.5px; font-weight:600; color:var(--sk-fg); text-align:center; }
.sk-scope .sk-lc-stage.todo .sk-lc-label { color:var(--sk-fg3); }
.sk-scope .sk-lc-stage.current .sk-lc-label,
.sk-scope .sk-lc-stage.warn .sk-lc-label,
.sk-scope .sk-lc-stage.danger .sk-lc-label { color:var(--sk-primary); }
.sk-scope .sk-lc-meta { font-size:10.5px; color:var(--sk-fg3); font-family:'JetBrains Mono', ui-monospace, monospace; white-space:nowrap; text-align:center; }
.sk-scope .sk-lc-conn { flex:0 0 28px; height:2px; background:var(--sk-border-d); margin:15px 4px 0; align-self:flex-start; }
.sk-scope .sk-lc-conn.done { background:var(--sk-success); }
.sk-scope .sk-lc-conn.next { background:linear-gradient(90deg, var(--sk-success), var(--sk-primary)); }

/* ── Summary Card (v1.4 §A.6 status-accented) ── */
.sk-scope .sk-summary { border:1px solid var(--sk-border); border-radius:10px; background:var(--sk-surface);
  overflow:hidden; transition: border-color .15s ease, box-shadow .15s ease; }
.sk-scope .sk-summary:hover { border-color:var(--sk-border-s); box-shadow:0 2px 10px rgba(0,0,0,.04); }
.sk-scope .sk-summary.done { border-left:3px solid var(--sk-success); }
.sk-scope .sk-summary.current { border-left:3px solid var(--sk-primary); }
.sk-scope .sk-summary.warn { border-left:3px solid var(--sk-warning); }
.sk-scope .sk-summary.danger { border-left:3px solid var(--sk-danger); }
.sk-scope .sk-summary.todo { border-left:3px solid var(--sk-border-s); }
.sk-scope .sk-summary-body { padding:14px 16px; display:grid; grid-template-columns:auto 1fr auto; gap:14px; align-items:center; }
.sk-scope .sk-summary-num { width:28px; height:28px; border-radius:50%; display:grid; place-items:center;
  font-size:12px; font-weight:700; flex-shrink:0; }
.sk-scope .sk-summary.done .sk-summary-num { background:var(--sk-success-bg); color:var(--sk-success-fg); }
.sk-scope .sk-summary.current .sk-summary-num { background:var(--sk-primary-soft); color:var(--sk-primary); }
.sk-scope .sk-summary.warn .sk-summary-num { background:var(--sk-warning-bg); color:var(--sk-warning-fg); }
.sk-scope .sk-summary.danger .sk-summary-num { background:var(--sk-danger-bg); color:var(--sk-danger-fg); }
.sk-scope .sk-summary.todo .sk-summary-num { background:var(--sk-elevated); color:var(--sk-fg3); }
.sk-scope .sk-summary-head { display:flex; align-items:center; gap:8px; margin-bottom:4px; flex-wrap:wrap; }
.sk-scope .sk-summary-title { font-size:14px; font-weight:700; color:var(--sk-fg); }
.sk-scope .sk-sb { font-size:10.5px; font-weight:600; padding:1px 7px; border-radius:3px; white-space:nowrap; }
.sk-scope .sk-sb.green { background:var(--sk-success-bg); color:var(--sk-success-fg); }
.sk-scope .sk-sb.amber { background:var(--sk-warning-bg); color:var(--sk-warning-fg); }
.sk-scope .sk-sb.red   { background:var(--sk-danger-bg);  color:var(--sk-danger-fg); }
.sk-scope .sk-sb.gray  { background:var(--sk-elevated); color:var(--sk-fg2); }
.sk-scope .sk-sb.brand { background:var(--sk-primary-soft); color:var(--sk-primary); }
.sk-scope .sk-summary-stats { display:flex; gap:16px; font-size:11.5px; color:var(--sk-fg3); flex-wrap:wrap; }
.sk-scope .sk-summary-stats strong { color:var(--sk-fg); font-weight:600; font-family:'JetBrains Mono', ui-monospace, monospace; }
.sk-scope .sk-summary-stats strong.warn { color:var(--sk-warning); }
.sk-scope .sk-summary-stats strong.danger { color:var(--sk-danger); }
.sk-scope .sk-summary-stats strong.success { color:var(--sk-success); }
.sk-scope .sk-summary-quote { margin-top:8px; font-size:12px; color:var(--sk-fg2); line-height:1.5;
  padding:8px 10px; background:var(--sk-warning-bg); border-radius:5px; border-left:2px solid var(--sk-warning); }
.sk-scope .sk-summary-quote strong { color:var(--sk-warning-fg); font-weight:600; }
.sk-scope .sk-go { background:var(--sk-surface); border:1px solid var(--sk-border-d); border-radius:6px;
  padding:7px 12px; font-size:12px; font-weight:600; color:var(--sk-fg2); cursor:pointer;
  display:inline-flex; align-items:center; gap:5px; white-space:nowrap; transition:all .15s ease;
  font-family:inherit; }
.sk-scope .sk-go:hover { border-color:var(--sk-primary); color:var(--sk-primary); background:var(--sk-primary-soft); }
.sk-scope .sk-go.primary { background:var(--sk-primary); color:#fff; border-color:var(--sk-primary); }
.sk-scope .sk-go.primary:hover { background:var(--sk-primary-deep); border-color:var(--sk-primary-deep); }
.sk-scope .sk-go:disabled { color:var(--sk-fg3); border-color:var(--sk-border); cursor:not-allowed; opacity:.6; background:var(--sk-surface); }
.sk-scope .sk-go.primary:disabled { background:var(--sk-border); border-color:var(--sk-border); color:var(--sk-surface); }
.sk-scope .sk-go svg { width:11px; height:11px; }

/* ── Preview Section (collapsible) ── */
.sk-scope .sk-preview { border:1px solid var(--sk-border); border-radius:10px; background:var(--sk-surface); overflow:hidden; }
.sk-scope .sk-preview-head { padding:12px 16px; background:var(--sk-elevated);
  border-bottom:1px solid var(--sk-border); display:flex; align-items:center; justify-content:space-between;
  cursor:pointer; transition: background .15s ease; gap:10px; }
.sk-scope .sk-preview-head.collapsed { border-bottom-color:transparent; }
.sk-scope .sk-preview-head:hover { background:var(--sk-border); }
.sk-scope .sk-preview-title { font-size:12.5px; font-weight:700; color:var(--sk-fg);
  display:flex; align-items:center; gap:8px; }
.sk-scope .sk-preview-chevron { color:var(--sk-fg3); transition: transform .2s ease; display:inline-flex; }
.sk-scope .sk-preview-chevron.open { transform: rotate(90deg); }
.sk-scope .sk-preview-body { padding:14px 16px; }
.sk-scope .sk-preview-actions { display:inline-flex; gap:6px; }

/* ── Top Selector Toolbar (对齐 /skill-eval 的 .sa-selector) ── */
.sk-scope .sk-toolbar { display:flex; align-items:center; gap:14px; background:var(--sk-surface);
  border:1px solid var(--sk-border); border-radius:12px; padding:10px 14px; margin-bottom:14px;
  box-shadow:0 1px 2px rgba(0,0,0,.04); flex-wrap:wrap; }
.sk-scope .sk-toolbar-title { display:flex; flex-direction:column; min-width:112px; padding-right:6px; border-right:1px solid var(--sk-border); }
.sk-scope .sk-toolbar-title-main { font-size:14px; font-weight:700; color:var(--sk-fg); line-height:1.3; }
.sk-scope .sk-toolbar-title-sub  { font-size:11px; color:var(--sk-fg3); margin-top:2px; }
.sk-scope .sk-toolbar-search { height:32px; min-width:200px; max-width:280px; flex:0 1 260px;
  border:1px solid var(--sk-border-d); border-radius:6px; padding:0 10px; font-size:13px;
  background:var(--input-bg, var(--sk-surface)); outline:none; font-family:inherit; color:var(--sk-fg); }
.sk-scope .sk-toolbar-search::placeholder { color:var(--sk-fg3); }
.sk-scope .sk-toolbar-search:focus { border-color:var(--sk-primary); box-shadow:0 0 0 3px var(--sk-ring-primary); }
.sk-scope .sk-toolbar-filter { display:flex; gap:2px; padding:3px; border-radius:8px; background:var(--sk-elevated); border:1px solid var(--sk-border); }
.sk-scope .sk-toolbar-filter button { padding:5px 12px; border-radius:6px; font-size:12px; font-weight:500;
  background:transparent; color:var(--sk-fg3); border:none; cursor:pointer; font-family:inherit;
  transition: background .15s ease, color .15s ease; }
.sk-scope .sk-toolbar-filter button.on { background:var(--sk-surface); color:var(--sk-fg);
  box-shadow:0 1px 2px rgba(0,0,0,.06), 0 0 0 1px var(--sk-border-d); }
.sk-scope .sk-toolbar-meta { display:flex; align-items:center; gap:10px; color:var(--sk-fg2);
  font-size:12px; flex-wrap:wrap; }
.sk-scope .sk-toolbar-meta-item { display:inline-flex; align-items:baseline; gap:4px; }
.sk-scope .sk-toolbar-meta-item .label { color:var(--sk-fg3); font-size:11px; }
.sk-scope .sk-toolbar-meta-item .val { font-family:'JetBrains Mono', ui-monospace, monospace; font-weight:700; color:var(--sk-fg); }
.sk-scope .sk-toolbar-meta-item .val.warn { color:var(--sk-warning); }
.sk-scope .sk-toolbar-meta-item .val.success { color:var(--sk-success); }
.sk-scope .sk-toolbar-meta .sep { color:var(--sk-border-s); user-select:none; }
.sk-scope .sk-toolbar-spacer { flex:1 1 auto; min-width:0; }
.sk-scope .sk-toolbar-action { height:32px; padding:0 14px; border-radius:6px;
  border:1px solid var(--sk-primary); background:var(--sk-primary); color:#fff;
  font-size:12.5px; font-weight:600; cursor:pointer;
  display:inline-flex; align-items:center; gap:6px; white-space:nowrap;
  transition: background .15s ease, border-color .15s ease;
  font-family:inherit; }
.sk-scope .sk-toolbar-action:hover { background:var(--sk-primary-deep); border-color:var(--sk-primary-deep); }
.sk-scope .sk-toolbar-action svg { width:14px; height:14px; }

/* ── Version Timeline ── */
.sk-scope .sk-timeline { display:flex; flex-direction:column; gap:0; padding-left:2px; }
.sk-scope .sk-tl-row { display:grid; grid-template-columns:32px 1fr; gap:12px; align-items:stretch; }
.sk-scope .sk-tl-rail { position:relative; display:flex; flex-direction:column; align-items:center; min-height:64px; }
.sk-scope .sk-tl-line { width:2px; flex:1 1 0; background:var(--sk-border-d); }
.sk-scope .sk-tl-line.top { min-height:8px; max-height:14px; }
.sk-scope .sk-tl-line.bottom { min-height:8px; }
.sk-scope .sk-tl-line.hidden { background:transparent; }
.sk-scope .sk-tl-dot { width:14px; height:14px; border-radius:50%; background:var(--sk-border-s);
  border:2px solid var(--sk-surface); flex-shrink:0; z-index:1; box-shadow:0 0 0 1px var(--sk-border-d); }
.sk-scope .sk-tl-dot.current { background:var(--sk-primary); box-shadow:0 0 0 1px var(--sk-primary), 0 0 0 4px var(--sk-ring-primary); }
.sk-scope .sk-tl-dot.active  { background:var(--sk-success); box-shadow:0 0 0 1px var(--sk-success); }
.sk-scope .sk-tl-card { border:1px solid var(--sk-border); border-radius:10px;
  background:var(--sk-surface); padding:12px 14px; margin:6px 0;
  transition: border-color .15s ease, background .15s ease, box-shadow .15s ease;
  cursor:pointer; }
.sk-scope .sk-tl-card:hover { border-color:var(--sk-border-s); }
.sk-scope .sk-tl-card.on { border-color:var(--sk-primary); box-shadow:0 0 0 3px var(--sk-ring-primary); background:var(--sk-primary-soft); }
.sk-scope .sk-tl-card.picked { border-color:var(--sk-primary); box-shadow:0 0 0 2px var(--sk-ring-primary); background:var(--sk-primary-soft); }
.sk-scope .sk-tl-check { width:14px; height:14px; accent-color:var(--sk-primary); cursor:pointer; }
.sk-scope .sk-tl-card .sep { color:var(--sk-border-s); user-select:none; }

/* ── Diff Panel ── */
.sk-scope .sk-diff-grid { display:flex; flex-direction:column; }
.sk-scope .sk-diff-row { display:grid; grid-template-columns:120px 1fr 1fr 80px; gap:12px;
  padding:8px 14px; border-bottom:1px solid var(--sk-border); font-size:12px; align-items:start; }
.sk-scope .sk-diff-row:last-child { border-bottom:none; }
.sk-scope .sk-diff-row.multiline { grid-template-columns:120px 1fr 1fr; }
.sk-scope .sk-diff-row .label { color:var(--sk-fg3); font-size:11px; padding-top:1px; }
.sk-scope .sk-diff-row .val { color:var(--sk-fg); word-break:break-word; white-space:pre-wrap; }
.sk-scope .sk-diff-row.multiline .val { line-height:1.6; }
.sk-scope .sk-diff-row .delta { text-align:right; }

.sk-scope .sk-diff-content { margin:0; padding:0; font-family:'JetBrains Mono', ui-monospace, monospace;
  font-size:12px; line-height:1.6; max-height:520px; overflow:auto; background:var(--sk-surface); }
.sk-scope .sk-diff-line { display:grid; grid-template-columns:24px 1fr; gap:0;
  padding:0 14px; align-items:start; }
.sk-scope .sk-diff-line .prefix { color:var(--sk-fg3); user-select:none; text-align:center; }
.sk-scope .sk-diff-line .text { white-space:pre-wrap; word-break:break-word; }
.sk-scope .sk-diff-line.add { background:var(--sk-success-bg); }
.sk-scope .sk-diff-line.add .prefix { color:var(--sk-success); font-weight:700; }
.sk-scope .sk-diff-line.add .text   { color:var(--sk-success-fg); }
.sk-scope .sk-diff-line.del { background:var(--sk-danger-bg); }
.sk-scope .sk-diff-line.del .prefix { color:var(--sk-danger); font-weight:700; }
.sk-scope .sk-diff-line.del .text   { color:var(--sk-danger-fg); }
.sk-scope .sk-diff-line.eq .text    { color:var(--sk-fg2); }
`;

// ───────── Atoms ─────────

function StatusBadge({ active, calls7d }: { active: boolean; calls7d: number }) {
    if (active && calls7d > 0) {
        return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, background: 'var(--sk-success-bg)', color: 'var(--sk-success)' }}>
                <span className="sk-pulse" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--sk-success)' }} />
                运行中
            </span>
        );
    }
    if (active) {
        return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, background: 'var(--sk-warning-bg)', color: 'var(--sk-warning)' }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--sk-warning)' }} />
                已激活·待引用
            </span>
        );
    }
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, background: 'var(--sk-elevated)', color: 'var(--sk-fg2)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--sk-fg3)' }} />
            未激活
        </span>
    );
}

function Sparkline({ data, color = 'var(--sk-success)', width = 100, height = 32 }: { data?: number[]; color?: string; width?: number; height?: number }) {
    if (!data || data.length === 0) return null;
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min || 1;
    const step = data.length > 1 ? width / (data.length - 1) : width;
    const points = data.map((v, i) => `${i * step},${height - ((v - min) / range) * (height - 4) - 2}`).join(' ');
    return (
        <svg width={width} height={height} style={{ display: 'block' }}>
            <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={`${points} ${width},${height} 0,${height}`} fill={color} opacity={0.08} />
        </svg>
    );
}

function formatDate(iso?: string): string {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}/${m}/${day}`;
    } catch {
        return '—';
    }
}

function formatDateTime(iso?: string): string {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleString();
    } catch {
        return '—';
    }
}

function vLabel(v: { semanticVersion?: string; version: number }): string {
    return v.semanticVersion ? `v${v.semanticVersion}` : `v${v.version}`;
}

// ───────── Skill 流程进度 KPI ─────────
//
// 取代原"质量"列的卡片 KPI（更简洁，单格 3 行）：
//   行 1：「2/3」 mono 阶段号
//   行 2：阶段名（已生成 / 已分析 / 已优化 / 分析中），颜色按 tone 着色
//   行 3：sub 一句话明细（下一步动作 / 待修复明细）
//
// 阶段语义采用"最近完成的阶段"（与用户确认的"阶段号 + 名称"展示对齐）：
//   - 未分析 → 1/3 已生成，灰色
//   - 分析中 → 1/3 分析中，indigo（视觉变体已就绪，等后端补 isAnalyzing 字段后接通）
//   - 已分析有问题 → 2/3 已分析，琥珀
//   - 已分析无问题 → 3/3 已优化，绿
type ProgressTone = 'gray' | 'amber' | 'green' | 'indigo';
interface SkillProgress {
    step: 1 | 2 | 3;
    label: string;
    sub: string;
    tone: ProgressTone;
}

function getSkillProgress(skill: SkillListItem): SkillProgress {
    const issues = skill.qualityIssues || { high: 0, medium: 0, low: 0 };
    const total = issues.high + issues.medium + issues.low;
    const hasEval = (skill.qualityScore ?? 0) >= 1;
    const hasIssues = total > 0;
    const activeVersion = skill.activeVersion ?? 0;
    const newerVersions = (skill.versions || []).filter(v => v.version > activeVersion);
    // TODO: 后端补 isAnalyzing 后接通；暂时恒 false
    const isAnalyzing = false;

    if (isAnalyzing) {
        return { step: 1, label: '分析中', sub: '请稍候…', tone: 'indigo' };
    }
    if (newerVersions.length > 0) {
        const newest = newerVersions.reduce((max, item) => Math.max(max, item.version), activeVersion);
        return { step: 3, label: '已优化', sub: `已有 v${newest}`, tone: 'green' };
    }
    if (!hasEval) {
        return { step: 1, label: '已生成', sub: '待分析', tone: 'gray' };
    }
    if (hasIssues) {
        const parts: string[] = [`${total} 项待优化`];
        if (issues.high > 0) parts.push(`高 ${issues.high}`);
        return { step: 2, label: '已分析', sub: parts.join(' · '), tone: 'amber' };
    }
    return { step: 2, label: '已分析', sub: '未优化 · 0 项问题', tone: 'amber' };
}

const PROGRESS_TONE_VAR: Record<ProgressTone, string> = {
    gray:   'var(--sk-fg2)',
    amber:  'var(--sk-warning)',
    green:  'var(--sk-success)',
    indigo: 'var(--sk-primary)',
};

function SkillProgressKpi({ skill }: { skill: SkillListItem }) {
    const p = getSkillProgress(skill);
    const color = PROGRESS_TONE_VAR[p.tone];
    return (
        <div>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--sk-fg3)', marginBottom: 4 }}>流程进度</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span className="sk-mono" style={{ fontSize: 13, fontWeight: 700, color }}>{p.step}/3</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--sk-fg3)', marginTop: 2 }}>{p.sub}</div>
        </div>
    );
}

// ───────── Skill Card ─────────

function SkillCard({
    skill,
    onOpen,
    onUploadSuccess,
}: {
    skill: SkillListItem;
    onOpen: (tab?: string) => void;
    onUploadSuccess?: () => void;
}) {
    const { user } = useAuth();
    const active = skill.activeVersion ?? 0;
    const issues = skill.qualityIssues || { high: 0, medium: 0, low: 0 };
    const total = issues.high + issues.medium + issues.low;
    const calls = skill.calls7d ?? 0;
    const agents = skill.agentsUsing ?? 0;
    const isActive = !!skill.isUploaded || calls > 0 || agents > 0;
    const versions = skill.versions || [];
    const showVersions = versions.slice(0, 4);

    // 卡片内"上传新版本"快捷入口 —— 把后端早已支持的 targetSkillId 暴露给用户:
    // 一键选文件夹直接传到该 skill,版本号自动递增。
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploadingVersion, setUploadingVersion] = useState(false);

    const handleVersionFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        // 校验文件夹名跟 skill name 一致(后端 line 84-88 也会拦,这里先给友好提示)
        const firstPath = files[0]?.webkitRelativePath || '';
        const folderName = firstPath.split('/')[0];
        if (folderName && folderName !== skill.name) {
            alert(`文件夹名「${folderName}」与 Skill「${skill.name}」不一致。\n上传新版本必须使用相同的文件夹名。`);
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }

        setUploadingVersion(true);
        try {
            const formData = new FormData();
            if (user) formData.append('user', user);
            formData.append('targetSkillId', skill.id);
            for (let i = 0; i < files.length; i++) {
                formData.append('files', files[i]);
                formData.append('paths', files[i].webkitRelativePath);
            }
            const res = await apiFetch('/api/skills/upload', { method: 'POST', body: formData });
            const result = await res.json();
            if (res.ok) {
                alert(`新版本上传成功：${result.skill.name} v${result.version.version}`);
                onUploadSuccess?.();
            } else {
                alert(`上传失败：${result.error || '未知错误'}`);
            }
        } catch (err: any) {
            alert(`上传失败：${err?.message || '网络错误'}`);
        } finally {
            setUploadingVersion(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="sk-card" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '18px 20px 14px', cursor: 'pointer' }} onClick={() => onOpen('overview')}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
                    <div className="sk-mono" style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', wordBreak: 'break-all' }}>{skill.name}</div>
                    <StatusBadge active={isActive} calls7d={calls} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--sk-fg3)', marginBottom: 12 }}>
                    <span>{versions.length || 1} 个版本</span>
                    <span>·</span>
                    <span>更新于 {formatDate(skill.updatedAt)}</span>
                </div>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--sk-fg2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {skill.description || '暂无描述'}
                </p>
            </div>

            <div onClick={() => onOpen('overview')} style={{ padding: '12px 20px', borderTop: '1px solid var(--sk-border)', background: 'transparent', cursor: 'pointer' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                    {/* 流程进度 —— 取代原"质量"列：把 lifecycle 信息压成一个 KPI
                        阶段语义（已生成/已分析/已优化/分析中）由 getSkillProgress() 派生，
                        与抽屉里大 LifecycleStepper 同源；sub 行补下一步动作或待修复明细 */}
                    <SkillProgressKpi skill={skill} />
                    <div>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--sk-fg3)', marginBottom: 4 }}>被引用</div>
                        <div className="sk-mono" style={{ fontSize: 14, fontWeight: 600 }}>{agents}</div>
                        <div style={{ fontSize: 10, color: 'var(--sk-fg3)' }}>个 Agent</div>
                    </div>
                    <div>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--sk-fg3)', marginBottom: 4 }}>七天内调用</div>
                        {calls > 0 ? (
                            <>
                                <div className="sk-mono" style={{ fontSize: 14, fontWeight: 600 }}>{calls.toLocaleString()}</div>
                                <div style={{ fontSize: 10, color: 'var(--sk-success)' }}>
                                    {skill.successRate != null ? `${skill.successRate}% 成功` : '—'}
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="sk-mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--sk-fg3)' }}>—</div>
                                <div style={{ fontSize: 10, color: 'var(--sk-fg3)' }}>无调用</div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            <div style={{ padding: '8px 20px 10px', marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--sk-fg3)' }}>跳到版本</span>
                <div style={{ display: 'flex', gap: 4, flex: 1, overflowX: 'auto' }} className="sk-scrollbar">
                    {showVersions.length === 0 && <span style={{ fontSize: 11, color: 'var(--sk-fg3)' }}>—</span>}
                    {showVersions.map(v => (
                        <button
                            key={v.version}
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onOpen('overview'); }}
                            className="sk-mono"
                            style={{
                                flexShrink: 0,
                                padding: '2px 8px',
                                borderRadius: 6,
                                fontSize: 10,
                                fontWeight: 600,
                                background: v.version === active ? 'var(--sk-success-bg)' : 'transparent',
                                color: v.version === active ? 'var(--sk-success)' : 'var(--sk-fg2)',
                                border: 'none',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                            }}
                            title={`v${v.version} · ${formatDate(v.createdAt)}`}
                        >
                            v{v.version}
                            {v.version === active && <span style={{ width: 4, height: 4, borderRadius: 999, background: 'var(--sk-success)' }} />}
                        </button>
                    ))}
                    {versions.length > 4 && (
                        <span style={{ fontSize: 10, color: 'var(--sk-fg3)', alignSelf: 'center' }}>+{versions.length - 4}</span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpen('history'); }}
                    style={{ fontSize: 10, fontWeight: 500, color: 'var(--sk-fg2)', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                    全部历史 →
                </button>
                {/* 一键上传新版本 —— chip 风格按钮:文字 + icon 同在可点击区,语义明确,
                    跟旁边的"全部历史 →"区分(那个是文字链接、这个是带边框的实体按钮),
                    用 indigo 主色让用户一眼识别"这是一个动作按钮" */}
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    disabled={uploadingVersion}
                    title={uploadingVersion
                        ? '上传中…'
                        : `上传 ${skill.name} 的新版本（文件夹名需为「${skill.name}」，版本号自动递增）`}
                    style={{
                        flexShrink: 0,
                        height: 22,
                        padding: '0 8px',
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        borderRadius: 6,
                        fontSize: 11, fontWeight: 600, lineHeight: 1,
                        color: uploadingVersion ? 'var(--sk-fg3)' : 'var(--sk-primary)',
                        background: uploadingVersion ? 'transparent' : 'var(--sk-primary-soft)',
                        border: '1px solid',
                        borderColor: uploadingVersion ? 'var(--sk-border)' : 'var(--sk-primary-border)',
                        cursor: uploadingVersion ? 'wait' : 'pointer',
                        transition: 'background 0.15s, border-color 0.15s',
                        whiteSpace: 'nowrap',
                    }}
                    onMouseEnter={e => { if (!uploadingVersion) { e.currentTarget.style.borderColor = 'var(--sk-primary)'; } }}
                    onMouseLeave={e => { if (!uploadingVersion) { e.currentTarget.style.borderColor = 'var(--sk-primary-border)'; } }}
                >
                    {uploadingVersion ? (
                        <span>上传中…</span>
                    ) : (
                        <>
                            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                                <path d="M6 2v8M2 6h8" />
                            </svg>
                            <span>新版本</span>
                        </>
                    )}
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    // @ts-ignore - webkitdirectory 是非标准属性
                    webkitdirectory=""
                    directory=""
                    multiple
                    style={{ display: 'none' }}
                    onChange={handleVersionFolderSelect}
                    onClick={e => e.stopPropagation()}
                />
            </div>
        </div>
    );
}

// ───────── Version Switcher ─────────

function VersionSwitcher({
    versions,
    currentVersion,
    activeVersion,
    onChange,
    onActivate,
}: {
    versions: VersionMeta[];
    currentVersion: number;
    activeVersion: number;
    onChange: (v: number) => void;
    onActivate: (v: number) => void;
}) {
    const [moreOpen, setMoreOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setMoreOpen(false); };
        document.addEventListener('mousedown', h);
        return () => document.removeEventListener('mousedown', h);
    }, []);

    const current = versions.find(v => v.version === currentVersion);
    const activeV = versions.find(v => v.version === activeVersion);
    const isActive = current?.version === activeVersion;
    const idx = versions.findIndex(v => v.version === currentVersion);

    const goPrev = () => { if (idx < versions.length - 1) onChange(versions[idx + 1].version); };
    const goNext = () => { if (idx > 0) onChange(versions[idx - 1].version); };

    // 顶部版本切换条背景：激活态用淡绿、历史态用 elevated 灰；皆走 tokens 适配暗模式
    const bg = isActive
        ? 'var(--sk-success-bg)'
        : 'var(--sk-elevated)';

    return (
        <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--sk-border)', background: bg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: isActive ? 'var(--sk-success)' : 'var(--sk-fg3)' }}>
                    {isActive ? '查看激活版本' : '查看历史版本'}
                </div>

                <div style={{ display: 'flex', gap: 2 }}>
                    <button type="button" onClick={goPrev} disabled={idx >= versions.length - 1} className="sk-btn" style={{ padding: '4px 6px' }} title="上一个版本 [">‹</button>
                    <button type="button" onClick={goNext} disabled={idx <= 0} className="sk-btn" style={{ padding: '4px 6px' }} title="下一个版本 ]">›</button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 8, border: '1px solid var(--sk-border-d)', background: 'var(--sk-surface)' }}>
                    {versions.slice(0, 4).map(v => (
                        <button
                            key={v.version}
                            type="button"
                            onClick={() => onChange(v.version)}
                            className={`sk-vchip sk-mono ${currentVersion === v.version ? 'on' : ''}`}
                            style={{
                                padding: '4px 10px',
                                borderRadius: 6,
                                fontSize: 11,
                                fontWeight: 600,
                                border: 'none',
                                background: currentVersion === v.version ? undefined : 'transparent',
                                color: currentVersion === v.version ? undefined : 'var(--sk-fg)',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                            }}
                            title={`${formatDate(v.createdAt)} · ${v.author || '—'}`}
                        >
                            {vLabel(v)}
                            {v.version === activeVersion && (
                                <span style={{ width: 4, height: 4, borderRadius: 999, background: currentVersion === v.version ? '#86efac' : 'var(--sk-success)' }} />
                            )}
                        </button>
                    ))}
                    {versions.length > 4 && (
                        <div style={{ position: 'relative' }} ref={ref}>
                            <button type="button" onClick={() => setMoreOpen(!moreOpen)} style={{ padding: '4px 8px', fontSize: 11, fontWeight: 500, background: 'transparent', border: 'none', cursor: 'pointer' }}>
                                更多 ▾
                            </button>
                            {moreOpen && (
                                <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 200, borderRadius: 8, border: '1px solid var(--sk-border-d)', background: 'var(--sk-surface)', boxShadow: '0 8px 24px rgba(0,0,0,.08)', padding: 4, zIndex: 10 }}>
                                    {versions.slice(4).map(v => (
                                        <button key={v.version} type="button" onClick={() => { onChange(v.version); setMoreOpen(false); }} style={{ width: '100%', padding: '6px 10px', textAlign: 'left', fontSize: 11, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderRadius: 4 }}>
                                            <span className="sk-mono" style={{ fontWeight: 600 }}>{vLabel(v)}</span>
                                            <span style={{ color: 'var(--sk-fg3)' }}>{formatDate(v.createdAt)}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {current && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--sk-fg3)' }}>
                        <span className="sk-mono">{formatDate(current.createdAt)}</span>
                        <span>·</span>
                        <span>{current.author || '—'}</span>
                    </div>
                )}

                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {isActive ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500, background: 'var(--sk-surface)', color: 'var(--sk-success)', border: '1px solid var(--sk-success)' }}>
                            ✓ 当前激活
                        </span>
                    ) : (
                        <>
                            <span style={{ fontSize: 11, color: 'var(--sk-fg3)' }}>
                                激活中：<span className="sk-mono" style={{ fontWeight: 600, color: 'var(--sk-fg2)' }}>{activeV ? vLabel(activeV) : '—'}</span>
                            </span>
                            <button type="button" onClick={() => onActivate(currentVersion)} className="sk-btn-primary">
                                激活此版本
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

// ───────── Execution Flow (React Flow graph) ─────────

type StepNodeData = {
    index: number;
    total: number;
    name: string;
    description?: string;
};

const NODE_WIDTH = 280;
const NODE_VPAD = 14;
const NODE_HPAD = 18;

const FLOW_FONT =
    '"Inter","PingFang SC","Microsoft YaHei","Source Han Sans CN",system-ui,-apple-system,sans-serif';

type NodeRole = 'start' | 'process' | 'end';

const NODE_PALETTE: Record<NodeRole, { bg: string; border: string; text: string; badge: string }> = {
    start:   { bg: '#EEF2FF', border: '#6366F1', text: '#3730A3', badge: '#6366F1' },
    process: { bg: '#FFFFFF', border: '#E2E8F0', text: '#1E293B', badge: '#64748B' },
    end:     { bg: '#ECFDF5', border: '#10B981', text: '#065F46', badge: '#10B981' },
};

function roleOf(i: number, total: number): NodeRole {
    if (i === 0) return 'start';
    if (i === total - 1) return 'end';
    return 'process';
}

function estimateNodeHeight(data: StepNodeData): number {
    // 280px width − 18 padding*2 − 24 badge − 12 gap ≈ 188px text area
    // Chinese char ~14px wide @ font-size 14 → ~13 chars/line; mix CJK/ASCII average ~16.
    const innerWidthChars = 16;
    const nameLines = Math.max(1, Math.ceil((data.name?.length ?? 0) / innerWidthChars));
    const descLines = data.description
        ? Math.max(1, Math.ceil(data.description.length / innerWidthChars))
        : 0;
    return NODE_VPAD * 2 + nameLines * 22 + (descLines > 0 ? descLines * 18 + 4 : 0);
}

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
    const role = roleOf(data.index, data.total);
    const c = NODE_PALETTE[role];
    return (
        <div
            style={{
                width: NODE_WIDTH,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: `${NODE_VPAD}px ${NODE_HPAD}px`,
                borderRadius: 10,
                background: c.bg,
                border: `1.5px solid ${c.border}`,
                boxShadow: '0 1px 3px rgba(15, 23, 42, 0.05), 0 4px 12px rgba(15, 23, 42, 0.04)',
                boxSizing: 'border-box',
                fontFamily: FLOW_FONT,
            }}
        >
            <Handle type="target" position={Position.Top} style={{ opacity: 0, top: 0 }} />
            <div
                style={{
                    flexShrink: 0,
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 600,
                    background: c.badge,
                    color: '#fff',
                    marginTop: 1,
                    lineHeight: 1,
                    letterSpacing: 0,
                }}
            >
                {data.index + 1}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div
                    style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: c.text,
                        lineHeight: 1.5,
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                    }}
                >
                    {data.name}
                </div>
                {data.description && (
                    <div
                        style={{
                            fontSize: 12,
                            marginTop: 4,
                            color: '#64748B',
                            lineHeight: 1.5,
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                        }}
                    >
                        {data.description}
                    </div>
                )}
            </div>
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0, bottom: 0 }} />
        </div>
    );
}

const NODE_TYPES = { step: StepNode };

function buildLayout(steps: FlowStep[]): { nodes: Node<StepNodeData>[]; edges: Edge[]; height: number } {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 44, marginx: 16, marginy: 16 });

    const rawNodes: Node<StepNodeData>[] = steps.map((s, i) => {
        const data: StepNodeData = {
            index: i,
            total: steps.length,
            name: s.name,
            description: s.description,
        };
        const height = estimateNodeHeight(data);
        g.setNode(`s-${i}`, { width: NODE_WIDTH, height });
        return {
            id: `s-${i}`,
            type: 'step',
            position: { x: 0, y: 0 },
            data,
            draggable: false,
            selectable: false,
        };
    });

    const edges: Edge[] = [];
    for (let i = 0; i < steps.length - 1; i++) {
        g.setEdge(`s-${i}`, `s-${i + 1}`);
        edges.push({
            id: `e-${i}`,
            source: `s-${i}`,
            target: `s-${i + 1}`,
            type: 'smoothstep',
            style: { stroke: '#94A3B8', strokeWidth: 2 },
            markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 18,
                height: 18,
                color: '#94A3B8',
            },
        });
    }

    dagre.layout(g);

    const nodes = rawNodes.map((n) => {
        const { x, y, width, height } = g.node(n.id);
        return {
            ...n,
            position: { x: x - width / 2, y: y - height / 2 },
        };
    });

    const { height: graphHeight } = g.graph();
    return { nodes, edges, height: graphHeight ?? 0 };
}

function normalizeMermaidCode(raw: string): string {
    return raw
        .split('\n')
        // Drop inline color overrides so our neutral theme actually applies.
        .filter(line => !/^\s*(style|classDef|class)\s+/i.test(line))
        .join('\n')
        // Collapse all node shapes (circle / double-circle / stadium / cylinder)
        // into plain rectangles so sizing is uniform. Keep {…} decisions.
        .replace(/\(\(\(([^()\n]+)\)\)\)/g, '[$1]')
        .replace(/\(\(([^()\n]+)\)\)/g, '[$1]')
        .replace(/\(\[([^\[\]\n]+)\]\)/g, '[$1]')
        .replace(/\[\(([^()\n]+)\)\]/g, '[$1]');
}

function SkillMermaidFlow({ code }: { code: string }) {
    const [svg, setSvg] = useState('');
    const [error, setError] = useState('');
    const idRef = useRef(`sk-mermaid-${Math.random().toString(36).slice(2)}`);

    useEffect(() => {
        let cancelled = false;
        setSvg('');
        setError('');
        if (!code) return;
        const normalized = normalizeMermaidCode(code);
        import('mermaid')
            .then(mod => {
                const mermaid = mod.default;
                mermaid.initialize({
                    startOnLoad: false,
                    theme: 'base',
                    themeVariables: {
                        primaryColor: '#f4f4f5',
                        primaryTextColor: '#27272a',
                        primaryBorderColor: '#d4d4d8',
                        secondaryColor: '#f4f4f5',
                        tertiaryColor: '#f4f4f5',
                        lineColor: '#a1a1aa',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        fontSize: '13px',
                    },
                    flowchart: {
                        curve: 'linear',
                        padding: 6,
                        nodeSpacing: 20,
                        rankSpacing: 28,
                        useMaxWidth: true,
                        htmlLabels: true,
                    },
                });
                return mermaid.render(`${idRef.current}-${Date.now()}`, normalized);
            })
            .then(({ svg }) => {
                if (cancelled) return;
                setSvg(svg);
            })
            .catch((e) => { if (!cancelled) setError(e?.message || '流程图渲染失败'); });
        return () => { cancelled = true; };
    }, [code]);

    if (error) return <div style={{ padding: 16, fontSize: 12, color: 'var(--sk-danger)' }}>流程图渲染失败：{error}</div>;
    if (!svg) return <div style={{ padding: 24, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>正在渲染流程图…</div>;
    return (
        <div className="sk-mermaid-wrap">
            <style>{`
                .sk-mermaid-wrap {
                    padding: 20px 16px;
                    background:
                        radial-gradient(circle at 1px 1px, #e4e4e7 1px, transparent 0) 0 0 / 16px 16px,
                        #fafafa;
                    border-radius: 10px;
                    border: 1px solid var(--sk-border);
                    overflow: auto;
                    display: flex;
                    justify-content: center;
                    align-items: flex-start;
                }
                .sk-mermaid-wrap > div {
                    width: 100%;
                    display: flex;
                    justify-content: center;
                }
                .sk-mermaid-wrap svg {
                    max-width: 520px !important;
                    width: 100% !important;
                    height: auto !important;
                    max-height: 520px !important;
                    display: block;
                }
                /* Uniform neutral node fill — kills the bright blue/green defaults */
                .sk-mermaid-wrap .node rect,
                .sk-mermaid-wrap .node polygon,
                .sk-mermaid-wrap .node circle,
                .sk-mermaid-wrap .node ellipse,
                .sk-mermaid-wrap .node path {
                    fill: #ffffff !important;
                    stroke: #d4d4d8 !important;
                    stroke-width: 1.25px !important;
                }
                /* Subtle accent for first / last node */
                .sk-mermaid-wrap .node:first-of-type rect,
                .sk-mermaid-wrap .node:first-of-type polygon,
                .sk-mermaid-wrap .node:first-of-type circle,
                .sk-mermaid-wrap .node:first-of-type ellipse,
                .sk-mermaid-wrap .node:first-of-type path {
                    fill: #eff6ff !important;
                    stroke: #93c5fd !important;
                }
                .sk-mermaid-wrap .node:last-of-type rect,
                .sk-mermaid-wrap .node:last-of-type polygon,
                .sk-mermaid-wrap .node:last-of-type circle,
                .sk-mermaid-wrap .node:last-of-type ellipse,
                .sk-mermaid-wrap .node:last-of-type path {
                    fill: #f0fdf4 !important;
                    stroke: #86efac !important;
                }
                .sk-mermaid-wrap .node .label,
                .sk-mermaid-wrap .node foreignObject div {
                    color: #18181b !important;
                    font-size: 12.5px !important;
                    font-weight: 500 !important;
                    line-height: 1.4 !important;
                }
                .sk-mermaid-wrap .edgePath .path,
                .sk-mermaid-wrap .flowchart-link {
                    stroke: #a1a1aa !important;
                    stroke-width: 1.25px !important;
                }
                .sk-mermaid-wrap .arrowheadPath,
                .sk-mermaid-wrap marker path {
                    fill: #a1a1aa !important;
                    stroke: #a1a1aa !important;
                }
                .sk-mermaid-wrap .edgeLabel {
                    background: #fafafa !important;
                    color: #52525b !important;
                    font-size: 11px !important;
                    padding: 1px 4px !important;
                }
            `}</style>
            <div dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
    );
}

function ExecutionFlow({ steps }: { steps: FlowStep[] }) {
    const { nodes, edges, height } = useMemo(() => buildLayout(steps), [steps]);
    const containerHeight = Math.min(Math.max(height + 48, 260), 640);

    return (
        <div
            style={{
                height: containerHeight,
                borderRadius: 10,
                overflow: 'hidden',
                border: '1px solid #E2E8F0',
                background: '#FAFBFC',
                fontFamily: FLOW_FONT,
            }}
        >
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                fitView
                fitViewOptions={{ padding: 0.15 }}
                minZoom={0.4}
                maxZoom={1.4}
                proOptions={{ hideAttribution: true }}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                panOnDrag
                zoomOnScroll
            >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#E2E8F0" />
                <Controls showInteractive={false} />
                {steps.length > 6 && <MiniMap pannable zoomable style={{ height: 80, width: 120 }} />}
            </ReactFlow>
        </div>
    );
}

// ───────── Tab: Overview ─────────

function TabOverview({
    skill,
    version,
    versions,
    versionDetail,
    evalSummary,
    analysisHealth,
    parsedFlow,
    flowLoading,
    onParseFlow,
    onJumpTab,
}: {
    skill: SkillListItem;
    version: VersionMeta;
    versions: VersionMeta[];
    versionDetail: VersionDetail | null;
    evalSummary: EvalSummary | null;
    analysisHealth: AnalysisHealthSummary | null;
    parsedFlow: ParsedFlow | null;
    flowLoading: boolean;
    onParseFlow: () => void;
    onJumpTab: (t: string) => void;
}) {
    const flowSteps = useMemo<FlowStep[]>(() => {
        if (!parsedFlow?.flowJson) return [];
        try {
            const j = JSON.parse(parsedFlow.flowJson);
            if (Array.isArray(j?.steps)) return j.steps;
        } catch { /* ignore */ }
        return [];
    }, [parsedFlow]);

    const sev = evalSummary?.latest?.severityHistogram || { high: 0, medium: 0, low: 0 };
    const issuesTotal = sev.high + sev.medium + sev.low;
    const analysisHealthPct = analysisHealth?.health ?? null;
    const hasAnalysisHealth = analysisHealthPct != null;
    const newerVersions = versions.filter(v => v.version > version.version);
    const hasNewerVersion = newerVersions.length > 0;
    const newestVersion = newerVersions.reduce<VersionMeta | null>((latest, item) => {
        if (!latest || item.version > latest.version) return item;
        return latest;
    }, null);
    const optimizedMeta = hasNewerVersion
        ? newerVersions.length === 1
            ? `已有 ${newestVersion ? vLabel(newestVersion) : '更新版本'}`
            : `已有 ${newestVersion ? vLabel(newestVersion) : '更新版本'} 等 ${newerVersions.length} 个新版本`
        : issuesTotal > 0
            ? `${issuesTotal} 项问题`
            : hasAnalysisHealth
                ? '0 项问题'
                : '等待分析';
    const calls = version.usage?.calls7d ?? 0;

    // 文件数：versionDetail.files 是 JSON 列表（不含 SKILL.md 本身），+1 给 SKILL.md
    const filesCount = useMemo(() => {
        if (!versionDetail?.files) return 1;
        try {
            const f = JSON.parse(versionDetail.files);
            return Array.isArray(f) ? f.length + 1 : 1;
        } catch { return 1; }
    }, [versionDetail]);

    // 生命周期状态机：
    //   stage1 (生成) 恒定 done —— skill 上传成功就走到这一步
    //   stage2 (分析) 只认 Skills 分析页同口径的综合健康分
    //   stage3 (优化) 当前版本后面已有更新版本即视为已优化
    const stage1 = 'done' as const;
    const stage2 = hasAnalysisHealth ? 'done' : 'todo';
    const stage3: 'todo' | 'done' | 'warn' | 'danger' =
        hasNewerVersion ? 'done'
        : issuesTotal > 0 ? (sev.high > 0 ? 'danger' : 'warn')
        : 'todo';
    const completedStages = (stage1 === 'done' ? 1 : 0) + (stage2 === 'done' ? 1 : 0) + (stage3 === 'done' ? 1 : 0);
    const healthToneLabel =
        analysisHealthPct == null ? '待分析'
        : analysisHealthPct >= 80 ? '健康'
        : analysisHealthPct >= 60 ? '需关注'
        : '急需优化';
    const healthBadgeTone: SummaryBadge['tone'] =
        analysisHealthPct == null ? 'gray'
        : analysisHealthPct >= 80 ? 'green'
        : 'amber';

    // 跳转：去分析 → /skill-eval?skill=<name>&version=<version>；去优化 → /skill-opt/<name>/<version>
    // 都用新标签页打开（用户指定），并提示 toast。
    const goAnalyze = () => {
        const url = `/skill-eval?skill=${encodeURIComponent(skill.name)}&version=${version.version}`;
        window.open(url, '_blank', 'noopener');
        toast.success(`正在新标签页打开「Skill 分析」：${skill.name} ${vLabel(version)}`);
    };
    const goOptimize = () => {
        const url = `/skill-opt/${encodeURIComponent(skill.name)}/${version.version}`;
        window.open(url, '_blank', 'noopener');
        toast.success(`正在新标签页打开「Skill 优化」：${skill.name} ${vLabel(version)}`);
    };

    const previewHasContent = flowSteps.length > 0 || !!parsedFlow?.mermaidCode;

    return (
        <div className="sk-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* ── 1. Lifecycle Stepper ── */}
            <div className="sk-lifecycle">
                <div className="sk-lifecycle-head">
                    <span className="sk-lifecycle-title">
                        <span aria-hidden style={{ color: 'var(--sk-primary)' }}>▸</span>
                        Skill 生命周期
                    </span>
                    <span className="sk-lifecycle-progress">进度 <strong>{completedStages}</strong> / 3</span>
                </div>
                <div className="sk-lifecycle-stages">
                    <LifecycleStage status={stage1} num={1} label="已生成" meta={`${vLabel(version)} · 已发布`} />
                    <div className={`sk-lc-conn ${stage2 === 'done' ? 'done' : ''}`} />
                    <LifecycleStage
                        status={stage2}
                        num={2}
                        label={hasAnalysisHealth ? '已分析' : '待分析'}
                        meta={hasAnalysisHealth ? `综合健康分 ${analysisHealthPct}` : '尚无综合健康分'}
                    />
                    <div className={`sk-lc-conn ${stage3 === 'done' ? 'done' : stage2 === 'done' ? 'next' : ''}`} />
                    <LifecycleStage
                        status={stage3}
                        num={3}
                        label={hasNewerVersion ? '已优化' : '未优化'}
                        meta={optimizedMeta}
                        showCount={!hasNewerVersion && issuesTotal > 0 ? issuesTotal : undefined}
                    />
                </div>
            </div>

            {/* ── 2. Summary Cards ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* 卡片 A — 生成 */}
                <SummaryCard
                    tone="done"
                    num={1}
                    title="生成"
                    badge={{ tone: 'green', label: '已完成' }}
                    stats={[
                        { value: skill.versions?.length || 1, suffix: '个版本' },
                        { value: filesCount, suffix: '个文件' },
                        { prefix: '更新于', value: formatDate(version.createdAt) },
                    ]}
                    cta={{ label: '查看内容', onClick: () => onJumpTab('content'), variant: 'ghost', icon: 'chevron' }}
                />

                {/* 卡片 B — 分析 */}
                <SummaryCard
                    tone={!hasAnalysisHealth ? 'todo' : analysisHealthPct >= 80 ? 'done' : 'current'}
                    num={2}
                    title="分析"
                    badge={
                        { tone: healthBadgeTone, label: healthToneLabel }
                    }
                    stats={
                        hasAnalysisHealth
                            ? [
                                { prefix: '综合健康分', value: `${analysisHealthPct}`, suffix: '/100', strongTone: analysisHealthPct < 60 ? 'warn' : undefined },
                                { prefix: '覆盖', value: `${analysisHealth?.coveredCount ?? 0}/${analysisHealth?.totalCount ?? ANALYSIS_HEALTH_TOTAL_DIMENSIONS}`, suffix: '维' },
                                { prefix: '七天内调用', value: calls.toLocaleString() },
                            ]
                            : [
                                { prefix: '综合健康分', value: '—' },
                                { prefix: '覆盖', value: '0/4', suffix: '维' },
                                { prefix: '七天内调用', value: calls.toLocaleString() },
                            ]
                    }
                    quote={
                        hasAnalysisHealth && analysisHealthPct < 80
                            ? (
                                <>
                                    综合健康分偏低，建议进入 Skills 分析页定位具体维度{issuesTotal > 0 ? <>；静态评估检出 <strong>{issuesTotal}</strong> 条问题</> : null}
                                </>
                              )
                            : undefined
                    }
                    cta={{ label: '去分析', onClick: goAnalyze, variant: hasAnalysisHealth && analysisHealthPct < 80 ? 'primary' : 'ghost', icon: 'external' }}
                />

                {/* 卡片 C — 优化 */}
                <SummaryCard
                    tone={hasNewerVersion ? 'done' : issuesTotal > 0 ? (sev.high > 0 ? 'danger' : 'warn') : 'todo'}
                    num={3}
                    title="优化"
                    badge={
                        hasNewerVersion ? { tone: 'green', label: '已优化' }
                        : issuesTotal > 0 ? { tone: 'red', label: `${issuesTotal} 项待修复` }
                        : { tone: 'gray', label: '未优化' }
                    }
                    stats={
                        hasNewerVersion
                            ? [{ value: newerVersions.length, suffix: '个更新版本' }, { prefix: '最新', value: newestVersion ? vLabel(newestVersion) : '—' }]
                            : issuesTotal > 0
                                ? [
                                    { prefix: '高优', value: sev.high, strongTone: sev.high > 0 ? 'danger' : undefined },
                                    { prefix: '中优', value: sev.medium, strongTone: sev.medium > 0 ? 'warn' : undefined },
                                    { prefix: '低优', value: sev.low },
                                ]
                                : hasAnalysisHealth
                                    ? [{ value: '0', suffix: '项问题' }]
                                    : [{ value: '—', suffix: '请先完成分析' }]
                    }
                    cta={{
                        label: hasNewerVersion ? '查看版本' : '去优化',
                        onClick: hasNewerVersion ? () => onJumpTab('versions') : goOptimize,
                        variant: 'ghost',
                        icon: hasNewerVersion ? 'chevron' : 'external',
                        disabled: !hasAnalysisHealth && !hasNewerVersion,
                    }}
                />
            </div>

            {/* ── 3. 预期执行链路（默认折叠） ── */}
            <PreviewSection
                title="预期执行链路"
                versionLabel={vLabel(version)}
                defaultExpanded={false}
                actions={(
                    <>
                        {previewHasContent && (
                            <button type="button" className="sk-btn" onClick={(e) => { e.stopPropagation(); onParseFlow(); }} title="重新解析">
                                ↻ 重新解析
                            </button>
                        )}
                        <button type="button" className="sk-btn" onClick={(e) => { e.stopPropagation(); onJumpTab('content'); }}>
                            查看 SKILL.md ↗
                        </button>
                    </>
                )}
                summary={
                    flowLoading ? '解析中…'
                    : previewHasContent ? `共 ${flowSteps.length || '若干'} 个步骤 · Agent 调用此 Skill 时按以下流程执行`
                    : '尚未解析执行流程'
                }
            >
                {flowLoading ? (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>解析中…</div>
                ) : flowSteps.length > 0 ? (
                    <ExecutionFlow steps={flowSteps} />
                ) : parsedFlow?.mermaidCode ? (
                    <SkillMermaidFlow code={parsedFlow.mermaidCode} />
                ) : (
                    <div style={{ padding: 24, textAlign: 'center', background: 'var(--sk-elevated)', borderRadius: 10, color: 'var(--sk-fg3)', fontSize: 12 }}>
                        <div style={{ marginBottom: 10 }}>暂无解析的执行流程</div>
                        <button type="button" className="sk-btn-primary" onClick={onParseFlow}>解析流程</button>
                    </div>
                )}
            </PreviewSection>
        </div>
    );
}

// ───────── Overview sub-components ─────────

function LifecycleStage({
    status,
    num,
    label,
    meta,
    showCount,
}: {
    status: 'done' | 'current' | 'warn' | 'danger' | 'todo';
    num: number;
    label: string;
    meta: string;
    showCount?: number;
}) {
    const content =
        status === 'done' ? '✓'
        : status === 'todo' ? num
        : (showCount != null ? showCount : num);
    return (
        <div className={`sk-lc-stage ${status}`}>
            <div className="sk-lc-dot">{content}</div>
            <div className="sk-lc-label">{label}</div>
            <div className="sk-lc-meta">{meta}</div>
        </div>
    );
}

type SummaryTone = 'done' | 'current' | 'warn' | 'danger' | 'todo';
type SummaryBadge = { tone: 'green' | 'amber' | 'red' | 'gray' | 'brand'; label: string };
type SummaryStat = { prefix?: string; value: React.ReactNode; suffix?: string; strongTone?: 'warn' | 'danger' | 'success' };
type SummaryCTA = {
    label: string;
    onClick: () => void;
    variant?: 'primary' | 'ghost';
    icon?: 'chevron' | 'external';
    disabled?: boolean;
};

function SummaryCard({
    tone,
    num,
    title,
    badge,
    stats,
    quote,
    cta,
}: {
    tone: SummaryTone;
    num: number;
    title: string;
    badge?: SummaryBadge;
    stats: SummaryStat[];
    quote?: React.ReactNode;
    cta: SummaryCTA;
}) {
    return (
        <div className={`sk-summary ${tone}`}>
            <div className="sk-summary-body">
                <div className="sk-summary-num">{num}</div>
                <div style={{ minWidth: 0 }}>
                    <div className="sk-summary-head">
                        <span className="sk-summary-title">{title}</span>
                        {badge && <span className={`sk-sb ${badge.tone}`}>{badge.label}</span>}
                    </div>
                    <div className="sk-summary-stats">
                        {stats.map((s, i) => (
                            <span key={i}>
                                {s.prefix && <>{s.prefix} </>}
                                <strong className={s.strongTone || ''}>{s.value}</strong>
                                {s.suffix && <> {s.suffix}</>}
                            </span>
                        ))}
                    </div>
                    {quote && <div className="sk-summary-quote">{quote}</div>}
                </div>
                <button
                    type="button"
                    className={`sk-go ${cta.variant === 'primary' ? 'primary' : ''}`}
                    onClick={cta.onClick}
                    disabled={cta.disabled}
                >
                    {cta.label}
                    {cta.icon === 'chevron' && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <polyline points="9 18 15 12 9 6" />
                        </svg>
                    )}
                    {cta.icon === 'external' && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <line x1="7" y1="17" x2="17" y2="7" />
                            <polyline points="7 7 17 7 17 17" />
                        </svg>
                    )}
                </button>
            </div>
        </div>
    );
}

function PreviewSection({
    title,
    versionLabel,
    defaultExpanded,
    actions,
    summary,
    children,
}: {
    title: string;
    versionLabel?: string;
    defaultExpanded?: boolean;
    actions?: React.ReactNode;
    summary?: React.ReactNode;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(!!defaultExpanded);
    return (
        <div className="sk-preview">
            <div
                className={`sk-preview-head ${open ? '' : 'collapsed'}`}
                onClick={() => setOpen(o => !o)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
            >
                <div className="sk-preview-title">
                    <span className={`sk-preview-chevron ${open ? 'open' : ''}`} aria-hidden>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <polyline points="9 18 15 12 9 6" />
                        </svg>
                    </span>
                    <span style={{ color: 'var(--sk-warning)' }} aria-hidden>⚡</span>
                    {title}
                    {versionLabel && (
                        <span className="sk-mono" style={{ padding: '1px 6px', borderRadius: 4, fontSize: 10, background: 'var(--sk-surface)', color: 'var(--sk-fg2)', border: '1px solid var(--sk-border)', fontWeight: 500 }}>
                            {versionLabel}
                        </span>
                    )}
                    {!open && summary && (
                        <span style={{ fontSize: 11, color: 'var(--sk-fg3)', fontWeight: 400, marginLeft: 8 }}>
                            · {summary}
                        </span>
                    )}
                </div>
                {actions && (
                    <div className="sk-preview-actions" onClick={(e) => e.stopPropagation()}>
                        {actions}
                    </div>
                )}
            </div>
            {open && (
                <div className="sk-preview-body">
                    {summary && <div style={{ fontSize: 11.5, color: 'var(--sk-fg3)', marginBottom: 10 }}>{summary}</div>}
                    {children}
                </div>
            )}
        </div>
    );
}

// ───────── Tab: History ─────────

// ── relative time helper (用于版本时间线 "2 小时前 / 昨天 14:23" 类显示) ──
function relativeTime(iso?: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffSec = Math.round(diffMs / 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (diffSec < 60) return '刚刚';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    if (diffSec < 86400 * 2) return `昨天 ${hh}:${mm}`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} 天前`;
    return formatDate(iso);
}

// ── 把 sev histogram 转成 0-100 健康分（与 TabOverview 同公式） ──
function severityToHealth(sev?: { high: number; medium: number; low: number } | null): number | null {
    if (!sev) return null;
    let q;
    if (sev.high > 1) q = 1;
    else if (sev.high === 1 || sev.medium > 3) q = 2;
    else if (sev.medium >= 2) q = 3;
    else q = 4;
    return q * 25;
}

function healthTone(pct: number | null): 'green' | 'amber' | 'red' | 'gray' {
    if (pct == null) return 'gray';
    if (pct >= 75) return 'green';
    if (pct >= 50) return 'amber';
    return 'red';
}

type TraceSkillRef = { name?: string | null; version?: number | null };
type TraceRecordForHealth = {
    upload_id?: string;
    task_id?: string;
    rootSkill?: TraceSkillRef | null;
    root_skill?: TraceSkillRef | null;
    answer_score?: number | null;
    answerScore?: number | null;
    execution_match?: {
        matchJson?: string | null;
    } | null;
};
type TriggerSetSummary = { set?: { items?: Array<{ shouldTrigger?: boolean }> } | null };
type TriggerRunSummary = { run?: { status?: string; passRate?: number | string | null } | null };
type GrayRunForHealth = {
    status?: string;
    score?: number;
    pass?: number;
    sessionId?: string;
    runs?: GrayRunForHealth[];
};
type GrayTaskForHealth = {
    configJson?: { skillId?: string; versionBId?: string };
    caseStatesJson?: Record<string, { a?: GrayRunForHealth; b?: GrayRunForHealth }> | { a?: GrayRunForHealth; b?: GrayRunForHealth };
};

const ANALYSIS_HEALTH_TOTAL_DIMENSIONS = 4;

function computeStaticHealthPct(latest: EvalSummary['latest']): number | null {
    if (!latest?.l2Scores?.scores) return null;
    let sum = 0;
    let scored = 0;
    for (const std of STATIC_EVAL_STANDARDS) {
        const value = std.dimensionAliases
            .map(alias => latest.l2Scores?.scores?.[alias])
            .find(score => typeof score === 'number' && Number.isFinite(score));
        if (typeof value === 'number') {
            sum += value;
            scored += 1;
        }
    }
    return scored > 0 ? Math.round((sum / scored) * 20) : null;
}

function getTracePrimarySkillForHealth(trace: TraceRecordForHealth): TraceSkillRef | null {
    const root = trace.root_skill || trace.rootSkill || null;
    return root?.name ? { name: root.name, version: root.version ?? null } : null;
}

function traceReferencesSkillForHealth(trace: TraceRecordForHealth, skillName: string, version: number) {
    const root = getTracePrimarySkillForHealth(trace);
    return root?.name === skillName && root.version === version;
}

function getTraceFlowScoreForHealth(trace: TraceRecordForHealth): number | null {
    const payload = safeJsonParse<{ summary?: { overallScore?: number }; matches?: Array<{ matchStatus?: string }>; skippedExpectedSteps?: unknown[] }>(
        trace.execution_match?.matchJson || undefined,
    );
    if (!payload) return null;
    if (typeof payload.summary?.overallScore === 'number') return payload.summary.overallScore;
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    const skipped = Array.isArray(payload.skippedExpectedSteps) ? payload.skippedExpectedSteps : [];
    const scoringMatches = matches.filter(match => match.matchStatus !== 'non_business');
    const total = scoringMatches.length + skipped.length;
    if (total === 0) return null;
    return scoringMatches.filter(match => match.matchStatus === 'matched').length / total;
}

function computeTraceHealthPct(traces: TraceRecordForHealth[], skillName: string, version: number): number | null {
    const aggregate = traces
        .filter(trace => traceReferencesSkillForHealth(trace, skillName, version))
        .reduce<{ sum: number; count: number }>((acc, trace) => {
            const result = typeof trace.answer_score === 'number' ? trace.answer_score
                : typeof trace.answerScore === 'number' ? trace.answerScore : null;
            const flow = getTraceFlowScoreForHealth(trace);
            if (result != null && flow != null) {
                acc.sum += (result + flow) / 2;
                acc.count += 1;
            }
            return acc;
        }, { sum: 0, count: 0 });
    return aggregate.count > 0 ? Math.round((aggregate.sum / aggregate.count) * 100) : null;
}

function computeTriggerHealthScore(setData: TriggerSetSummary, runData: TriggerRunSummary): { passed: number; total: number } | null {
    const itemCount = Array.isArray(setData?.set?.items) ? setData.set.items.length : 0;
    const run = runData?.run;
    if (itemCount <= 0 || run?.status !== 'done') return null;
    const passRate = Number(run.passRate ?? 0);
    if (!Number.isFinite(passRate)) return null;
    return { passed: Math.round(passRate * itemCount), total: itemCount };
}

function getGrayRunScoreForHealth(run: GrayRunForHealth | undefined): number | null {
    if (!run) return null;
    if (typeof run.score === 'number') return run.score;
    if (typeof run.pass === 'number') return run.pass;
    return null;
}

function collectGrayScoresForHealth(side: GrayRunForHealth | undefined): number[] {
    if (!side) return [];
    const runs = Array.isArray(side.runs) ? side.runs : [];
    if (runs.length > 0) {
        return runs.map(getGrayRunScoreForHealth).filter((score): score is number => score != null);
    }
    const score = getGrayRunScoreForHealth(side);
    const hasSingle = side.status === 'pass' || side.status === 'fail' || score != null || !!side.sessionId;
    return hasSingle && score != null ? [score] : [];
}

function computeGrayHealthPct(tasks: GrayTaskForHealth[], skillId: string, versionId?: string): number | null {
    const latest = tasks.find(task => {
        if (task?.configJson?.skillId !== skillId) return false;
        if (!versionId) return true;
        return task.configJson?.versionBId === versionId;
    });
    const states = latest?.caseStatesJson || {};
    const isLegacy = 'a' in states || 'b' in states;
    const scores = isLegacy
        ? collectGrayScoresForHealth((states as { b?: GrayRunForHealth }).b)
        : Object.values(states as Record<string, { b?: GrayRunForHealth }>).flatMap(state => collectGrayScoresForHealth(state?.b));
    return scores.length > 0 ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
}

function safeJsonParse<T = unknown>(value?: string): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

async function loadAnalysisHealthSummary(args: {
    skill: SkillListItem;
    version: number;
    versionId?: string;
    user: string | null;
}): Promise<AnalysisHealthSummary> {
    const { skill, version, versionId, user } = args;
    const empty = { health: null, coveredCount: 0, totalCount: ANALYSIS_HEALTH_TOTAL_DIMENSIONS };
    if (!user) return empty;

    const userParam = encodeURIComponent(user);
    const [staticSummary, traces, triggerSet, triggerRun, grayTasks] = await Promise.all([
        apiFetch(`/api/skills/${skill.id}/versions/${version}/evaluation-summary?user=${userParam}`, { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null),
        apiFetch(`/api/observe/data?user=${userParam}&includeEvaluations=0&_ts=${Date.now()}`, { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : []))
            .catch(() => []),
        apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skill.name)}?user=${userParam}&_ts=${Date.now()}`, { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : { set: null }))
            .catch(() => ({ set: null })),
        apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skill.name)}/runs?user=${userParam}&latestOnly=true&skillVersion=${version}&_ts=${Date.now()}`, { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : { run: null }))
            .catch(() => ({ run: null })),
        apiFetch(`/api/debug/grayscale-tasks?user=${userParam}&_ts=${Date.now()}`, { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : []))
            .catch(() => []),
    ]);

    const staticPct = computeStaticHealthPct(staticSummary?.latest ?? null);
    const tracePct = Array.isArray(traces) ? computeTraceHealthPct(traces, skill.name, version) : null;
    const triggerScore = computeTriggerHealthScore(triggerSet, triggerRun);
    const grayPct = Array.isArray(grayTasks) ? computeGrayHealthPct(grayTasks, skill.id, versionId) : null;
    const scores = [
        staticPct != null ? { passed: staticPct, total: 100 } : null,
        tracePct != null ? { passed: tracePct, total: 100 } : null,
        triggerScore,
        grayPct != null ? { passed: grayPct, total: 100 } : null,
    ].filter((score): score is { passed: number; total: number } => !!score && score.total > 0);

    if (scores.length === 0) return empty;
    const total = scores.reduce((sum, score) => sum + score.total, 0);
    const passed = scores.reduce((sum, score) => sum + score.passed, 0);
    return {
        health: total > 0 ? Math.round((passed / total) * 100) : null,
        coveredCount: scores.length,
        totalCount: ANALYSIS_HEALTH_TOTAL_DIMENSIONS,
    };
}

// ── 缓存：每个版本的 SKILL.md 内容 / changeLog / files / evalSummary ──
type VersionAux = {
    content?: string;
    changeLog?: string;
    files?: string[];
    eval?: { sev: { high: number; medium: number; low: number }; issuesCount: number; runs: number } | null;
};

function TabHistory({
    skillId,
    user,
    versions,
    currentVersion,
    activeVersion,
    onSelect,
    onActivate,
    onDelete,
}: {
    skillId: string;
    user: string | null;
    versions: VersionMeta[];
    currentVersion: number;
    activeVersion: number;
    onSelect: (v: number) => void;
    onActivate: (v: number) => void;
    onDelete: (v: number) => void;
}) {
    // 进入历史 tab 时一次性把所有版本的 eval summary 拉回来（并行 + 容错），
    // 时间线右侧的健康分徽章就能立刻渲染；版本明细 (SKILL.md / changeLog / files)
    // 走"懒加载"——只在进入对比模式时按需拉两个被选中的版本，避免拉 N 次详情。
    const [aux, setAux] = useState<Record<number, VersionAux>>({});

    useEffect(() => {
        if (!skillId || versions.length === 0) return;
        let aborted = false;
        const qs = user ? `?user=${encodeURIComponent(user)}` : '';
        versions.forEach(v => {
            apiFetch(`/api/skills/${skillId}/versions/${v.version}/evaluation-summary${qs}`)
                .then(r => r.ok ? r.json() : null)
                .then((d: EvalSummary | null) => {
                    if (aborted || !d) return;
                    const sev = d.latest?.severityHistogram || { high: 0, medium: 0, low: 0 };
                    setAux(prev => ({
                        ...prev,
                        [v.version]: {
                            ...prev[v.version],
                            eval: d.latest
                                ? { sev, issuesCount: d.latest.issuesCount ?? 0, runs: d.history?.length ?? 0 }
                                : null,
                        },
                    }));
                })
                .catch(() => undefined);
        });
        return () => { aborted = true; };
    }, [skillId, user, versions]);

    // 模式：list 浏览态；compare 多选态；diff 对比详情态
    const [mode, setMode] = useState<'list' | 'compare' | 'diff'>('list');
    const [selected, setSelected] = useState<number[]>([]);   // 选中要对比的 version 号（最多 2）
    const [diffPair, setDiffPair] = useState<[number, number] | null>(null);

    const toggleSelect = (v: number) => {
        setSelected(prev => {
            if (prev.includes(v)) return prev.filter(x => x !== v);
            if (prev.length >= 2) return [prev[1], v]; // 已经 2 个时挤掉最早的
            return [...prev, v];
        });
    };

    const startDiff = () => {
        if (selected.length !== 2) return;
        // 排序：旧版本在前（base），新版本在后（target）—— 这样 "+ 行" 是新增
        const [a, b] = selected.slice().sort((x, y) => x - y);
        setDiffPair([a, b]);
        setMode('diff');
    };

    const exitCompare = () => {
        setMode('list');
        setSelected([]);
    };

    const exitDiff = () => {
        setMode('compare');
        setDiffPair(null);
    };

    // 触发对比时，按需拉两个版本的明细。
    // 注意：依赖里不要放 aux —— aux 在请求 resolve 后会更新，若放进依赖会触发
    // 同一 version 重复请求；这里用 setAux 的函数式更新读 prev.content 来做"已缓存"判断。
    const inFlight = useRef<Set<number>>(new Set());
    useEffect(() => {
        if (mode !== 'diff' || !diffPair) return;
        let aborted = false;
        const qs = user ? `?user=${encodeURIComponent(user)}` : '';
        diffPair.forEach(v => {
            if (inFlight.current.has(v)) return;
            inFlight.current.add(v);
            apiFetch(`/api/skills/${skillId}/versions/${v}${qs}`)
                .then(r => r.ok ? r.json() : null)
                .then((d: VersionDetail | null) => {
                    if (aborted) return;
                    if (!d) { inFlight.current.delete(v); return; }
                    let fileList: string[] = [];
                    try { fileList = d.files ? JSON.parse(d.files) : []; } catch { /* ignore */ }
                    setAux(prev => {
                        if (prev[v]?.content != null) return prev; // 已被别处缓存
                        return {
                            ...prev,
                            [v]: {
                                ...prev[v],
                                content: d.content ?? '',
                                changeLog: d.changeLog ?? '',
                                files: Array.isArray(fileList) ? fileList : [],
                            },
                        };
                    });
                })
                .catch(() => undefined)
                .finally(() => { inFlight.current.delete(v); });
        });
        return () => { aborted = true; };
    }, [mode, diffPair, skillId, user]);

    if (mode === 'diff' && diffPair) {
        return (
            <DiffPanel
                baseV={diffPair[0]}
                targetV={diffPair[1]}
                versions={versions}
                aux={aux}
                onBack={exitDiff}
                onActivate={onActivate}
            />
        );
    }

    const compareMode = mode === 'compare';
    const canStart = compareMode && selected.length === 2;

    return (
        <div className="sk-fade-in">
            {/* 顶栏：标题 + "对比差异" / "开始对比" / "取消" */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, gap: 12 }}>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>版本历史</div>
                    <div style={{ fontSize: 11, color: 'var(--sk-fg3)' }}>
                        {compareMode
                            ? `已选 ${selected.length} / 2 个版本${selected.length === 2 ? '，可开始对比' : '，再选 1 个进行差异对比'}`
                            : `共 ${versions.length} 个版本`}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    {!compareMode ? (
                        <button
                            type="button"
                            className="sk-btn"
                            onClick={() => { setMode('compare'); setSelected([]); }}
                            disabled={versions.length < 2}
                            title={versions.length < 2 ? '至少需要 2 个版本才能对比' : '选择 2 个版本对比差异'}
                        >
                            ⇄ 对比差异
                        </button>
                    ) : (
                        <>
                            <button type="button" className="sk-btn" onClick={exitCompare}>取消</button>
                            <button type="button" className="sk-btn-primary" onClick={startDiff} disabled={!canStart}>
                                开始对比 →
                            </button>
                        </>
                    )}
                </div>
            </div>

            {versions.length === 0 && (
                <div className="sk-card" style={{ padding: 32, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>
                    暂无历史版本
                </div>
            )}

            {/* 时间线容器：左侧 dot column + 右侧卡片 */}
            <div className="sk-timeline">
                {versions.map((v, i) => {
                    const isCurrent = v.version === currentVersion;
                    const isActive = v.version === activeVersion;
                    const isFirst = i === 0;
                    const isLast = i === versions.length - 1;
                    const health = severityToHealth(aux[v.version]?.eval?.sev || null);
                    const tone = healthTone(health);
                    const isSelected = selected.includes(v.version);
                    return (
                        <div key={v.version} className="sk-tl-row">
                            {/* dot + connector */}
                            <div className="sk-tl-rail">
                                <div className={`sk-tl-line top ${isFirst ? 'hidden' : ''}`} />
                                <div className={`sk-tl-dot ${isActive ? 'active' : isCurrent ? 'current' : ''}`} />
                                <div className={`sk-tl-line bottom ${isLast ? 'hidden' : ''}`} />
                            </div>

                            {/* card */}
                            <div
                                className={`sk-tl-card ${isCurrent ? 'on' : ''} ${isSelected ? 'picked' : ''}`}
                                onClick={() => {
                                    if (compareMode) toggleSelect(v.version);
                                    else onSelect(v.version);
                                }}
                                role="button"
                                tabIndex={0}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                                    {compareMode && (
                                        <input
                                            type="checkbox"
                                            checked={isSelected}
                                            onChange={() => toggleSelect(v.version)}
                                            onClick={(e) => e.stopPropagation()}
                                            className="sk-tl-check"
                                            aria-label={`选择 ${vLabel(v)} 加入对比`}
                                        />
                                    )}
                                    <span className="sk-mono" style={{ fontSize: 15, fontWeight: 700, color: isCurrent ? 'var(--sk-primary)' : 'var(--sk-fg)' }}>{vLabel(v)}</span>
                                    {isActive && <span className="sk-sb green">✓ 激活中</span>}
                                    {!isActive && isCurrent && <span className="sk-sb brand">当前查看</span>}
                                    <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                        {health != null && (
                                            <span className={`sk-sb ${tone}`} title={`健康分 ${health}%`}>{health}</span>
                                        )}
                                    </div>
                                </div>

                                <div style={{ fontSize: 13, color: 'var(--sk-fg)', marginBottom: 6, whiteSpace: 'pre-wrap', fontWeight: 500 }}>
                                    {v.changeLog || <span style={{ color: 'var(--sk-fg3)', fontStyle: 'italic', fontWeight: 400 }}>无变更说明</span>}
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--sk-fg3)', flexWrap: 'wrap' }}>
                                    <span>{relativeTime(v.createdAt)}</span>
                                    <span className="sep">·</span>
                                    <span>{aux[v.version]?.eval ? '已评测' : '未评测'}</span>
                                    {v.author && <><span className="sep">·</span><span className="sk-mono">{v.author}</span></>}
                                    {v.usage && v.usage.calls7d > 0 && (
                                        <>
                                            <span className="sep">·</span>
                                            <span>{v.usage.calls7d.toLocaleString()} 次调用 / 7d</span>
                                        </>
                                    )}
                                </div>

                                {!compareMode && !isActive && (
                                    <div style={{ display: 'flex', gap: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--sk-border)' }} onClick={(e) => e.stopPropagation()}>
                                        <button type="button" className="sk-btn" onClick={() => onActivate(v.version)}>激活</button>
                                        <button type="button" className="sk-btn" style={{ color: 'var(--sk-danger)', borderColor: 'var(--sk-danger-bg)' }} onClick={() => onDelete(v.version)}>删除</button>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ── Diff Panel: 元信息 + SKILL.md 行级 diff + 质量指标对比 ──

function DiffPanel({
    baseV,
    targetV,
    versions,
    aux,
    onBack,
    onActivate,
}: {
    baseV: number;
    targetV: number;
    versions: VersionMeta[];
    aux: Record<number, VersionAux>;
    onBack: () => void;
    onActivate: (v: number) => void;
}) {
    const base = versions.find(v => v.version === baseV);
    const target = versions.find(v => v.version === targetV);
    const baseAux = aux[baseV];
    const targetAux = aux[targetV];

    const contentLoaded = baseAux?.content != null && targetAux?.content != null;

    // 行级 diff —— 仅在内容到位后计算
    const diffParts = useMemo(() => {
        if (!contentLoaded) return [] as Array<{ value: string; added?: boolean; removed?: boolean }>;
        return diffLines(baseAux!.content || '', targetAux!.content || '');
    }, [contentLoaded, baseAux, targetAux]);

    const diffStats = useMemo(() => {
        let added = 0, removed = 0;
        for (const p of diffParts) {
            if (p.added) added += (p.value.match(/\n/g)?.length ?? 0) + (p.value && !p.value.endsWith('\n') ? 1 : 0);
            else if (p.removed) removed += (p.value.match(/\n/g)?.length ?? 0) + (p.value && !p.value.endsWith('\n') ? 1 : 0);
        }
        return { added, removed };
    }, [diffParts]);

    // 文件改动名单：base / target 各自的 files 集合做差集
    const fileChanges = useMemo(() => {
        if (!baseAux?.files || !targetAux?.files) return null;
        const bSet = new Set(baseAux.files);
        const tSet = new Set(targetAux.files);
        const added: string[] = [];
        const removed: string[] = [];
        const kept: string[] = [];
        for (const f of tSet) (bSet.has(f) ? kept : added).push(f);
        for (const f of bSet) if (!tSet.has(f)) removed.push(f);
        return { added: added.sort(), removed: removed.sort(), kept: kept.sort() };
    }, [baseAux, targetAux]);

    if (!base || !target) {
        return (
            <div className="sk-card" style={{ padding: 32, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>
                版本不存在
                <div style={{ marginTop: 12 }}>
                    <button type="button" className="sk-btn" onClick={onBack}>← 返回</button>
                </div>
            </div>
        );
    }

    const baseSev = baseAux?.eval?.sev;
    const targetSev = targetAux?.eval?.sev;
    const baseHealth = severityToHealth(baseSev || null);
    const targetHealth = severityToHealth(targetSev || null);
    const baseCalls = base.usage?.calls7d ?? 0;
    const targetCalls = target.usage?.calls7d ?? 0;
    const baseRate = base.usage?.successRate;
    const targetRate = target.usage?.successRate;
    const baseP95 = base.usage?.p95Latency;
    const targetP95 = target.usage?.p95Latency;

    return (
        <div className="sk-fade-in">
            {/* Diff 顶栏 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                <button type="button" className="sk-btn" onClick={onBack}>← 返回版本列表</button>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
                    <span className="sk-mono">{vLabel(base)}</span>
                    <span style={{ color: 'var(--sk-fg3)' }}>↔</span>
                    <span className="sk-mono" style={{ color: 'var(--sk-primary)' }}>{vLabel(target)}</span>
                </div>
                <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--sk-fg3)' }}>
                    base = 旧版本 · target = 新版本
                </div>
            </div>

            {/* 1. 元信息对比 */}
            <div className="sk-card" style={{ marginBottom: 12 }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--sk-border)', fontSize: 12, fontWeight: 600, color: 'var(--sk-fg)' }}>元信息对比</div>
                <div className="sk-diff-grid">
                    <DiffRow label="发布时间" base={formatDateTime(base.createdAt)} target={formatDateTime(target.createdAt)} mono />
                    <DiffRow label="作者" base={base.author || '—'} target={target.author || '—'} mono />
                    <DiffRow label="Change Log" base={base.changeLog || '—'} target={target.changeLog || '—'} multiline />
                </div>
            </div>

            {/* 2. 质量指标对比 */}
            <div className="sk-card" style={{ marginBottom: 12 }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--sk-border)', fontSize: 12, fontWeight: 600, color: 'var(--sk-fg)' }}>质量与运行指标</div>
                <div className="sk-diff-grid">
                    <DiffRow
                        label="健康分"
                        base={baseHealth != null ? `${baseHealth}%` : '—'}
                        target={targetHealth != null ? `${targetHealth}%` : '—'}
                        delta={baseHealth != null && targetHealth != null ? targetHealth - baseHealth : null}
                        deltaSuffix="%"
                        higherIsBetter
                        mono
                    />
                    <DiffRow
                        label="高优问题"
                        base={baseSev?.high ?? '—'}
                        target={targetSev?.high ?? '—'}
                        delta={baseSev && targetSev ? targetSev.high - baseSev.high : null}
                        higherIsBetter={false}
                        mono
                    />
                    <DiffRow
                        label="中优问题"
                        base={baseSev?.medium ?? '—'}
                        target={targetSev?.medium ?? '—'}
                        delta={baseSev && targetSev ? targetSev.medium - baseSev.medium : null}
                        higherIsBetter={false}
                        mono
                    />
                    <DiffRow
                        label="七天内调用"
                        base={baseCalls.toLocaleString()}
                        target={targetCalls.toLocaleString()}
                        delta={targetCalls - baseCalls}
                        higherIsBetter
                        mono
                    />
                    <DiffRow
                        label="成功率"
                        base={baseRate != null ? `${baseRate}%` : '—'}
                        target={targetRate != null ? `${targetRate}%` : '—'}
                        delta={baseRate != null && targetRate != null ? targetRate - baseRate : null}
                        deltaSuffix="%"
                        higherIsBetter
                        mono
                    />
                    <DiffRow
                        label="P95 延迟"
                        base={baseP95 != null ? `${baseP95}ms` : '—'}
                        target={targetP95 != null ? `${targetP95}ms` : '—'}
                        delta={baseP95 != null && targetP95 != null ? targetP95 - baseP95 : null}
                        deltaSuffix="ms"
                        higherIsBetter={false}
                        mono
                    />
                </div>
            </div>

            {/* 3. 文件改动 */}
            <div className="sk-card" style={{ marginBottom: 12 }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--sk-border)', fontSize: 12, fontWeight: 600, color: 'var(--sk-fg)' }}>
                    文件改动
                    {fileChanges && (
                        <span style={{ fontWeight: 400, color: 'var(--sk-fg3)', marginLeft: 8 }}>
                            {fileChanges.added.length > 0 && <span style={{ color: 'var(--sk-success)' }}>+{fileChanges.added.length} </span>}
                            {fileChanges.removed.length > 0 && <span style={{ color: 'var(--sk-danger)' }}>−{fileChanges.removed.length} </span>}
                            {fileChanges.added.length === 0 && fileChanges.removed.length === 0 && '无变化'}
                        </span>
                    )}
                </div>
                <div style={{ padding: '10px 14px' }}>
                    {!fileChanges ? (
                        <div style={{ color: 'var(--sk-fg3)', fontSize: 12 }}>加载中…</div>
                    ) : fileChanges.added.length === 0 && fileChanges.removed.length === 0 ? (
                        <div style={{ color: 'var(--sk-fg3)', fontSize: 12 }}>两个版本的文件列表一致</div>
                    ) : (
                        <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12, lineHeight: 1.8 }}>
                            {fileChanges.added.map(f => (
                                <li key={'a:' + f} className="sk-mono" style={{ color: 'var(--sk-success)' }}>+ {f}</li>
                            ))}
                            {fileChanges.removed.map(f => (
                                <li key={'r:' + f} className="sk-mono" style={{ color: 'var(--sk-danger)' }}>− {f}</li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            {/* 4. SKILL.md 行级 diff */}
            <div className="sk-card">
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--sk-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--sk-fg)' }}>SKILL.md 差异</span>
                    {contentLoaded && (
                        <span style={{ fontSize: 11, color: 'var(--sk-fg3)' }}>
                            {diffStats.added > 0 && <span style={{ color: 'var(--sk-success)' }}>+{diffStats.added} </span>}
                            {diffStats.removed > 0 && <span style={{ color: 'var(--sk-danger)' }}>−{diffStats.removed} </span>}
                            {diffStats.added === 0 && diffStats.removed === 0 && '无变化'}
                        </span>
                    )}
                </div>
                {!contentLoaded ? (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>加载 SKILL.md 内容中…</div>
                ) : diffParts.length === 1 && !diffParts[0].added && !diffParts[0].removed ? (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>两个版本的 SKILL.md 内容完全一致</div>
                ) : (
                    <pre className="sk-diff-content sk-scrollbar">
                        {diffParts.map((p, i) => {
                            const cls = p.added ? 'add' : p.removed ? 'del' : 'eq';
                            const prefix = p.added ? '+' : p.removed ? '−' : ' ';
                            return p.value.split('\n').map((line, j, arr) => {
                                if (j === arr.length - 1 && line === '') return null;
                                return (
                                    <div key={`${i}-${j}`} className={`sk-diff-line ${cls}`}>
                                        <span className="prefix">{prefix}</span>
                                        <span className="text">{line || ' '}</span>
                                    </div>
                                );
                            });
                        })}
                    </pre>
                )}
            </div>

            {/* 底部辅助操作 */}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                {target.version !== base.version && (
                    <button type="button" className="sk-btn" onClick={() => onActivate(target.version)}>
                        激活 {vLabel(target)}
                    </button>
                )}
            </div>
        </div>
    );
}

function DiffRow({
    label,
    base,
    target,
    delta,
    deltaSuffix,
    higherIsBetter,
    mono,
    multiline,
}: {
    label: string;
    base: React.ReactNode;
    target: React.ReactNode;
    delta?: number | null;
    deltaSuffix?: string;
    higherIsBetter?: boolean;
    mono?: boolean;
    multiline?: boolean;
}) {
    let deltaNode: React.ReactNode = null;
    if (delta != null && delta !== 0) {
        const isUp = delta > 0;
        const isGood = higherIsBetter === undefined ? null : (higherIsBetter ? isUp : !isUp);
        const color = isGood == null ? 'var(--sk-fg3)' : isGood ? 'var(--sk-success)' : 'var(--sk-danger)';
        const sign = isUp ? '↑' : '↓';
        const abs = Math.abs(delta);
        deltaNode = (
            <span className="sk-mono" style={{ color, fontSize: 11, fontWeight: 600 }}>
                {sign} {abs}{deltaSuffix || ''}
            </span>
        );
    }
    return (
        <div className={`sk-diff-row ${multiline ? 'multiline' : ''}`}>
            <div className="label">{label}</div>
            <div className={mono ? 'sk-mono val' : 'val'}>{base}</div>
            <div className={mono ? 'sk-mono val' : 'val'}>{target}</div>
            <div className="delta">{deltaNode}</div>
        </div>
    );
}

// ───────── Tab: Content ─────────

interface FileTreeNode {
    name: string;
    path: string;
    isDir: boolean;
    children?: FileTreeNode[];
}

function buildFileTree(paths: string[]): FileTreeNode[] {
    const root: FileTreeNode = { name: '', path: '', isDir: true, children: [] };
    for (const p of paths) {
        const parts = p.split('/').filter(Boolean);
        let node = root;
        for (let i = 0; i < parts.length; i++) {
            const isLeaf = i === parts.length - 1;
            const fullPath = parts.slice(0, i + 1).join('/');
            const existing = node.children!.find(c => c.name === parts[i]);
            if (existing) {
                node = existing;
            } else {
                const next: FileTreeNode = {
                    name: parts[i],
                    path: fullPath,
                    isDir: !isLeaf,
                    children: isLeaf ? undefined : [],
                };
                node.children!.push(next);
                node = next;
            }
        }
    }
    const sortRec = (n: FileTreeNode) => {
        if (!n.children) return;
        n.children.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        n.children.forEach(sortRec);
    };
    sortRec(root);
    return root.children!;
}

function FileTreeView({
    nodes,
    selectedPath,
    onSelect,
    depth = 0,
}: {
    nodes: FileTreeNode[];
    selectedPath: string;
    onSelect: (p: string) => void;
    depth?: number;
}) {
    return (
        <>
            {nodes.map(n => {
                const active = n.path === selectedPath;
                return (
                    <div key={n.path || n.name}>
                        <div
                            onClick={() => { if (!n.isDir) onSelect(n.path); }}
                            style={{
                                padding: '6px 10px',
                                paddingLeft: 10 + depth * 14,
                                fontSize: 12,
                                cursor: n.isDir ? 'default' : 'pointer',
                                background: active ? 'var(--sk-elevated)' : 'transparent',
                                borderLeft: active ? '2px solid var(--sk-accent)' : '2px solid transparent',
                                color: n.isDir ? 'var(--sk-fg3)' : (active ? 'var(--sk-fg)' : 'var(--sk-fg2)'),
                                fontWeight: active ? 600 : (n.isDir ? 600 : 400),
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                userSelect: 'none',
                            }}
                        >
                            <span style={{ fontSize: 10, opacity: 0.7 }}>{n.isDir ? '📁' : '📄'}</span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
                        </div>
                        {n.isDir && n.children && (
                            <FileTreeView nodes={n.children} selectedPath={selectedPath} onSelect={onSelect} depth={depth + 1} />
                        )}
                    </div>
                );
            })}
        </>
    );
}

function TabContent({
    skillId,
    user,
    version,
    versionDetail,
}: {
    skillId: string;
    user: string | null;
    version: VersionMeta;
    versionDetail: VersionDetail | null;
}) {
    const skillMdContent = versionDetail?.content || '';
    const extraFiles = useMemo<string[]>(() => {
        if (!versionDetail?.files) return [];
        try { const f = JSON.parse(versionDetail.files); return Array.isArray(f) ? f : []; }
        catch { return []; }
    }, [versionDetail]);

    const allFiles = useMemo<string[]>(() => {
        const set = new Set<string>(['SKILL.md']);
        extraFiles.forEach(f => set.add(f));
        return Array.from(set);
    }, [extraFiles]);

    const tree = useMemo(() => buildFileTree(allFiles), [allFiles]);

    const [selectedPath, setSelectedPath] = useState<string>('SKILL.md');
    const [fileContent, setFileContent] = useState<string>('');
    const [fileMeta, setFileMeta] = useState<{ size: number; isText: boolean; truncated?: boolean } | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => { setSelectedPath('SKILL.md'); }, [version.version, skillId]);

    useEffect(() => {
        let aborted = false;
        if (selectedPath === 'SKILL.md') {
            setFileContent(skillMdContent);
            setFileMeta({ size: skillMdContent.length, isText: true });
            return;
        }
        setLoading(true);
        setFileContent('');
        setFileMeta(null);
        const qs = user ? `?user=${encodeURIComponent(user)}` : '';
        const parts = selectedPath.split('/').map(encodeURIComponent).join('/');
        apiFetch(`/api/skills/${skillId}/versions/${version.version}/files/${parts}${qs}`)
            .then(r => r.json())
            .then(d => {
                if (aborted) return;
                setFileContent(d?.content || '');
                setFileMeta({ size: d?.size ?? 0, isText: !!d?.isText, truncated: !!d?.truncated });
            })
            .catch(() => { if (!aborted) setFileMeta({ size: 0, isText: false }); })
            .finally(() => { if (!aborted) setLoading(false); });
        return () => { aborted = true; };
    }, [selectedPath, skillId, version.version, user, skillMdContent]);

    const handleDownload = () => {
        const qs = user ? `?user=${encodeURIComponent(user)}` : '';
        window.open(`/api/skills/${skillId}/versions/${version.version}/download${qs}`, '_blank');
    };

    const sizeLabel = fileMeta
        ? fileMeta.size > 1024 ? `${(fileMeta.size / 1024).toFixed(1)} KB` : `${fileMeta.size} B`
        : '';

    return (
        <div className="sk-fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 10 }}>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>Skill 文件</div>
                    <div style={{ fontSize: 11, color: 'var(--sk-fg3)' }}>
                        当前查看 <span className="sk-mono" style={{ fontWeight: 600, color: 'var(--sk-fg2)' }}>{vLabel(version)}</span> · 共 {allFiles.length} 个文件
                    </div>
                </div>
                <button type="button" className="sk-btn" onClick={handleDownload} title="下载该版本的全部文件 (zip)" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12 }}>⬇</span>
                    下载 zip
                </button>
            </div>

            <div className="sk-card" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 480, overflow: 'hidden' }}>
                {/* Left: file tree */}
                <div className="sk-scrollbar" style={{ borderRight: '1px solid var(--sk-border)', background: 'var(--sk-elevated)', overflowY: 'auto', maxHeight: 600, padding: '8px 0' }}>
                    <FileTreeView nodes={tree} selectedPath={selectedPath} onSelect={setSelectedPath} />
                </div>

                {/* Right: file content */}
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--sk-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--sk-surface)' }}>
                        <span className="sk-mono" style={{ fontSize: 11, color: 'var(--sk-fg2)' }}>{selectedPath}</span>
                        <span style={{ fontSize: 10, color: 'var(--sk-fg3)' }}>
                            {fileMeta?.truncated ? '文件较大，未加载预览' : sizeLabel}
                        </span>
                    </div>
                    {loading ? (
                        <div style={{ padding: 32, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>加载中…</div>
                    ) : fileMeta && !fileMeta.isText ? (
                        <div style={{ padding: 32, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>
                            二进制文件不支持预览，请下载查看
                        </div>
                    ) : fileMeta?.truncated ? (
                        <div style={{ padding: 32, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>
                            文件超过 512KB，已跳过预览
                        </div>
                    ) : (
                        <pre className="sk-mono sk-scrollbar" style={{ margin: 0, padding: 16, fontSize: 12, lineHeight: 1.6, color: 'var(--sk-fg2)', whiteSpace: 'pre-wrap', maxHeight: 560, overflow: 'auto' }}>
                            {fileContent || '(空文件)'}
                        </pre>
                    )}
                </div>
            </div>
        </div>
    );
}

// ───────── Tab: Runs ─────────

interface RunItem {
    trace_id: string;
    agent: string | null;
    started_at: string | null;
    duration_ms: number | null;
    status: 'success' | 'failed' | 'pending' | 'unknown';
    version: number | null;
    query: string | null;
}

function formatDuration(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function runStatusLabel(s: RunItem['status']): { text: string; color: string; bg: string } {
    switch (s) {
        case 'success': return { text: '成功', color: 'var(--sk-success)', bg: 'var(--sk-success-bg)' };
        case 'failed': return { text: '失败', color: 'var(--sk-danger)', bg: 'var(--sk-danger-bg)' };
        case 'pending': return { text: '进行中', color: 'var(--sk-info)', bg: 'var(--sk-info-bg)' };
        default: return { text: '未知', color: 'var(--sk-fg3)', bg: 'var(--sk-elevated)' };
    }
}

function TabRuns({
    skillId,
    user,
    currentVersion,
    onTotalChange,
}: {
    skillId: string;
    user: string | null;
    currentVersion: number;
    onTotalChange: (n: number) => void;
}) {
    const [scope, setScope] = useState<'current' | 'all'>('current');
    const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all');
    const [agentFilter, setAgentFilter] = useState<string>('');
    const [items, setItems] = useState<RunItem[]>([]);
    const [total, setTotal] = useState<number>(0);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let aborted = false;
        setLoading(true);
        const params = new URLSearchParams();
        if (user) params.set('user', user);
        if (scope === 'current') params.set('version', String(currentVersion));
        params.set('limit', '200');
        apiFetch(`/api/skills/${skillId}/runs?${params.toString()}`)
            .then(r => r.json())
            .then((d: { total: number; items: RunItem[] }) => {
                if (aborted) return;
                if (Array.isArray(d?.items)) {
                    setItems(d.items);
                    setTotal(d.total ?? d.items.length);
                    onTotalChange(d.total ?? d.items.length);
                }
            })
            .catch(() => {})
            .finally(() => { if (!aborted) setLoading(false); });
        return () => { aborted = true; };
    }, [skillId, user, scope, currentVersion]);

    const agents = useMemo(() => {
        const set = new Set<string>();
        items.forEach(r => { if (r.agent) set.add(r.agent); });
        return Array.from(set).sort();
    }, [items]);

    const filtered = useMemo(() => {
        return items.filter(r => {
            if (statusFilter !== 'all' && r.status !== statusFilter) return false;
            if (agentFilter && r.agent !== agentFilter) return false;
            return true;
        });
    }, [items, statusFilter, agentFilter]);

    const stats = useMemo(() => {
        let success = 0, failed = 0, latSum = 0, latCount = 0;
        items.forEach(r => {
            if (r.status === 'success') success++;
            else if (r.status === 'failed') failed++;
            if (typeof r.duration_ms === 'number') { latSum += r.duration_ms; latCount++; }
        });
        return {
            calls: items.length,
            success,
            failed,
            avgLatency: latCount > 0 ? Math.round(latSum / latCount) : null,
        };
    }, [items]);

    return (
        <div className="sk-fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 }}>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>运行记录 <span className="sk-mono" style={{ fontWeight: 500, fontSize: 11, color: 'var(--sk-fg3)' }}>v{currentVersion}</span></div>
                    <div style={{ fontSize: 11, color: 'var(--sk-fg3)' }}>
                        {scope === 'current' ? `仅显示 v${currentVersion} 版本的调用记录` : '显示该 Skill 所有版本的调用记录'}
                    </div>
                </div>
                <div style={{ display: 'inline-flex', border: '1px solid var(--sk-border-d)', borderRadius: 8, overflow: 'hidden' }}>
                    <button
                        type="button"
                        onClick={() => setScope('current')}
                        style={{
                            padding: '6px 12px', fontSize: 11, fontWeight: 500, cursor: 'pointer',
                            border: 'none',
                            background: scope === 'current' ? 'var(--sk-primary)' : 'var(--sk-surface)',
                            color: scope === 'current' ? '#fff' : 'var(--sk-fg2)',
                        }}
                    >仅此版本</button>
                    <button
                        type="button"
                        onClick={() => setScope('all')}
                        style={{
                            padding: '6px 12px', fontSize: 11, fontWeight: 500, cursor: 'pointer',
                            border: 'none', borderLeft: '1px solid var(--sk-border-d)',
                            background: scope === 'all' ? 'var(--sk-primary)' : 'var(--sk-surface)',
                            color: scope === 'all' ? '#fff' : 'var(--sk-fg2)',
                        }}
                    >全部版本</button>
                </div>
            </div>

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
                {[
                    { label: '调用', value: stats.calls.toLocaleString(), color: 'var(--sk-fg)' },
                    { label: '成功', value: stats.success.toLocaleString(), color: 'var(--sk-success)' },
                    { label: '失败', value: stats.failed.toLocaleString(), color: 'var(--sk-danger)' },
                    { label: '平均延迟', value: stats.avgLatency != null ? formatDuration(stats.avgLatency) : '—', color: 'var(--sk-fg)' },
                ].map(s => (
                    <div key={s.label} className="sk-card" style={{ padding: 14 }}>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--sk-fg3)', marginBottom: 6 }}>{s.label}</div>
                        <div className="sk-mono" style={{ fontSize: 22, fontWeight: 700, color: s.color, lineHeight: 1.1 }}>{s.value}</div>
                    </div>
                ))}
            </div>

            {/* Filters */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'inline-flex', border: '1px solid var(--sk-border-d)', borderRadius: 8, overflow: 'hidden' }}>
                    {([['all', '全部'], ['success', '成功'], ['failed', '失败']] as const).map(([k, label], i) => (
                        <button
                            key={k}
                            type="button"
                            onClick={() => setStatusFilter(k)}
                            style={{
                                padding: '5px 12px', fontSize: 11, fontWeight: 500, cursor: 'pointer',
                                border: 'none', borderLeft: i === 0 ? 'none' : '1px solid var(--sk-border-d)',
                                background: statusFilter === k ? 'var(--sk-primary)' : 'var(--sk-surface)',
                                color: statusFilter === k ? '#fff' : 'var(--sk-fg2)',
                            }}
                        >{label}</button>
                    ))}
                </div>
                <select
                    className="sk-input"
                    value={agentFilter}
                    onChange={e => setAgentFilter(e.target.value)}
                    style={{ padding: '5px 10px', fontSize: 11 }}
                >
                    <option value="">全部 Agent ({agents.length})</option>
                    {agents.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--sk-fg3)' }}>显示 {filtered.length} 条</div>
            </div>

            {/* Table */}
            <div className="sk-card" style={{ overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 70px 80px 80px 1fr', gap: 0, padding: '10px 14px', background: 'var(--sk-elevated)', borderBottom: '1px solid var(--sk-border)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--sk-fg3)', fontWeight: 600 }}>
                    <div>开始时间</div>
                    <div>Agent</div>
                    <div>版本</div>
                    <div>状态</div>
                    <div>耗时</div>
                    <div>Trace ID</div>
                </div>
                {loading ? (
                    <div style={{ padding: 32, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>加载中…</div>
                ) : filtered.length === 0 ? (
                    <div style={{ padding: 32, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>
                        {scope === 'current' ? `v${currentVersion} 暂无运行记录` : '暂无运行记录'}
                    </div>
                ) : (
                    filtered.map((r, i) => {
                        const st = runStatusLabel(r.status);
                        return (
                            <div
                                key={r.trace_id || i}
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: '160px 1fr 70px 80px 80px 1fr',
                                    gap: 0,
                                    padding: '10px 14px',
                                    borderBottom: i === filtered.length - 1 ? 'none' : '1px solid var(--sk-border)',
                                    fontSize: 12,
                                    alignItems: 'center',
                                }}
                            >
                                <div className="sk-mono" style={{ color: 'var(--sk-fg2)', fontSize: 11 }}>{formatDateTime(r.started_at || undefined)}</div>
                                <div style={{ color: 'var(--sk-fg2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.agent || ''}>
                                    {r.agent || <span style={{ color: 'var(--sk-fg3)' }}>—</span>}
                                </div>
                                <div className="sk-mono" style={{ color: 'var(--sk-fg2)' }}>{r.version != null ? `v${r.version}` : '—'}</div>
                                <div>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 11, background: st.bg, color: st.color }}>
                                        <span style={{ width: 5, height: 5, borderRadius: 999, background: st.color }} />
                                        {st.text}
                                    </span>
                                </div>
                                <div className="sk-mono" style={{ color: r.status === 'failed' ? 'var(--sk-warning)' : 'var(--sk-fg2)' }}>{formatDuration(r.duration_ms)}</div>
                                <div
                                    className="sk-mono"
                                    style={{ color: 'var(--sk-fg3)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: r.trace_id ? 'copy' : 'default' }}
                                    title={r.trace_id || ''}
                                    onClick={() => { if (r.trace_id) navigator.clipboard?.writeText(r.trace_id).catch(() => {}); }}
                                >
                                    {r.trace_id || '—'}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
            {total > items.length && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--sk-fg3)', textAlign: 'center' }}>
                    仅显示最近 {items.length} / {total} 条
                </div>
            )}
        </div>
    );
}

// ───────── Drawer ─────────

function SkillDrawer({
    skill,
    user,
    onClose,
    onChanged,
}: {
    skill: SkillListItem;
    user: string | null;
    onClose: () => void;
    onChanged: () => void;
}) {
    const [versions, setVersions] = useState<VersionMeta[]>([]);
    const [activeVersion, setActiveVersion] = useState<number>(skill.activeVersion ?? 0);
    const [currentVersion, setCurrentVersion] = useState<number>(skill.activeVersion ?? 0);
    const [tab, setTab] = useState<string>('overview');

    const [versionDetail, setVersionDetail] = useState<VersionDetail | null>(null);
    const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
    const [analysisHealth, setAnalysisHealth] = useState<AnalysisHealthSummary | null>(null);
    const [parsedFlow, setParsedFlow] = useState<ParsedFlow | null>(null);
    const [flowLoading, setFlowLoading] = useState(false);
    const [versionsLoading, setVersionsLoading] = useState(true);
    const [runsTotal, setRunsTotal] = useState<number | null>(null);

    const userQuery = `?user=${encodeURIComponent(user || '')}`;

    // Load versions
    const loadVersions = () => {
        setVersionsLoading(true);
        apiFetch(`/api/skills/${skill.id}/versions${userQuery}`)
            .then(r => r.json())
            .then((d: VersionMeta[]) => {
                if (Array.isArray(d)) {
                    setVersions(d.sort((a, b) => b.version - a.version));
                }
            })
            .catch(() => {})
            .finally(() => setVersionsLoading(false));
    };
    useEffect(() => { loadVersions(); /* eslint-disable-next-line */ }, [skill.id]);

    useEffect(() => {
        setActiveVersion(skill.activeVersion ?? 0);
        setCurrentVersion(skill.activeVersion ?? 0);
    }, [skill.id, skill.activeVersion]);

    const current = versions.find(v => v.version === currentVersion);

    // Load version detail + eval + flow whenever currentVersion changes
    useEffect(() => {
        let aborted = false;
        setVersionDetail(null);
        setEvalSummary(null);
        setParsedFlow(null);

        apiFetch(`/api/skills/${skill.id}/versions/${currentVersion}${userQuery}`)
            .then(r => r.json())
            .then(d => { if (!aborted) setVersionDetail(d); })
            .catch(() => {});

        apiFetch(`/api/skills/${skill.id}/versions/${currentVersion}/evaluation-summary${userQuery}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (!aborted && d) setEvalSummary(d); })
            .catch(() => {});

        setFlowLoading(true);
        apiFetch(`/api/skills/${skill.id}/versions/${currentVersion}/parse-flow${userQuery}`)
            .then(r => r.json())
            .then(d => { if (!aborted) setParsedFlow(d); })
            .catch(() => {})
            .finally(() => { if (!aborted) setFlowLoading(false); });

        return () => { aborted = true; };
    }, [skill.id, currentVersion, user]);

    useEffect(() => {
        let aborted = false;
        setAnalysisHealth(null);
        loadAnalysisHealthSummary({ skill, version: currentVersion, versionId: current?.id, user })
            .then(summary => { if (!aborted) setAnalysisHealth(summary); })
            .catch(() => { if (!aborted) setAnalysisHealth({ health: null, coveredCount: 0, totalCount: ANALYSIS_HEALTH_TOTAL_DIMENSIONS }); });
        return () => { aborted = true; };
    }, [skill, currentVersion, current?.id, user]);

    // Keyboard nav
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.key === 'Escape') onClose();
            if (e.key === '[') {
                const idx = versions.findIndex(v => v.version === currentVersion);
                if (idx < versions.length - 1) setCurrentVersion(versions[idx + 1].version);
            }
            if (e.key === ']') {
                const idx = versions.findIndex(v => v.version === currentVersion);
                if (idx > 0) setCurrentVersion(versions[idx - 1].version);
            }
        };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
    }, [versions, currentVersion, onClose]);

    const handleActivate = async (v: number) => {
        try {
            const r = await apiFetch(`/api/skills/${skill.id}/activate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version: v, user }),
            });
            if (r.ok) {
                setActiveVersion(v);
                onChanged();
            } else {
                const d = await r.json();
                alert(`激活失败：${d.error || r.status}`);
            }
        } catch (e: any) {
            alert(`错误：${e?.message || e}`);
        }
    };

    const handleDelete = async (v: number) => {
        if (!confirm(`确定删除版本 v${v}？此操作不可撤销。`)) return;
        try {
            const r = await apiFetch(`/api/skills/${skill.id}/versions/${v}${userQuery}`, { method: 'DELETE' });
            if (r.ok) {
                loadVersions();
                onChanged();
                if (currentVersion === v) setCurrentVersion(activeVersion);
            } else {
                const d = await r.json();
                alert(`删除失败：${d.error || r.status}`);
            }
        } catch (e: any) {
            alert(`错误：${e?.message || e}`);
        }
    };

    const handleParseFlow = async () => {
        setFlowLoading(true);
        try {
            const r = await apiFetch(`/api/skills/${skill.id}/versions/${currentVersion}/parse-flow`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user }),
            });
            const d = await r.json();
            if (d.success) {
                setParsedFlow({
                    parsed: true,
                    flowJson: JSON.stringify(d.flow),
                    mermaidCode: d.mermaidCode,
                    parsedAt: new Date().toISOString(),
                });
            } else {
                alert(`解析失败：${d.error || ''}`);
            }
        } catch (e: any) {
            alert(`解析错误：${e?.message || e}`);
        } finally {
            setFlowLoading(false);
        }
    };

    const tabs: Array<{ id: string; label: string; count?: number }> = [
        { id: 'overview', label: '概览' },
        { id: 'content', label: '内容' },
        { id: 'versions', label: '版本', count: versions.length },
        { id: 'runs', label: '运行记录', count: runsTotal ?? undefined },
    ];

    return (
        <>
            <div className="sk-drawer-overlay" onClick={onClose} />
            <div className="sk-drawer sk-scope">
                {/* Header */}
                <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--sk-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <StatusBadge active={(skill.calls7d ?? 0) > 0 || (skill.agentsUsing ?? 0) > 0 || !!skill.isUploaded} calls7d={skill.calls7d ?? 0} />
                                <span style={{ fontSize: 11, color: 'var(--sk-fg3)' }}>
                                    · {versions.length || skill.versions?.length || 1} 个版本 · 更新于 {formatDate(skill.updatedAt)}
                                </span>
                            </div>
                            <h2 className="sk-mono" style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>{skill.name}</h2>
                            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--sk-fg2)' }}>{skill.description || '暂无描述'}</p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="关闭" style={{ padding: 8, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--sk-fg2)' }}>×</button>
                    </div>
                </div>

                {/* Version Switcher */}
                {versionsLoading ? (
                    <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--sk-border)', background: 'var(--sk-elevated)', fontSize: 11, color: 'var(--sk-fg3)' }}>
                        加载版本中…
                    </div>
                ) : versions.length > 0 ? (
                    <VersionSwitcher
                        versions={versions}
                        currentVersion={currentVersion}
                        activeVersion={activeVersion}
                        onChange={setCurrentVersion}
                        onActivate={handleActivate}
                    />
                ) : null}

                {/* Tabs */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 24px', borderBottom: '1px solid var(--sk-border)' }}>
                    {tabs.map(t => (
                        <button
                            key={t.id}
                            type="button"
                            className={`sk-tab ${tab === t.id ? 'on' : ''}`}
                            onClick={() => setTab(t.id)}
                            style={{ padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        >
                            {t.label}
                            {t.count != null && t.count > 0 && (
                                <span className="sk-mono" style={{ padding: '1px 6px', borderRadius: 4, fontSize: 10, background: tab === t.id ? 'var(--sk-primary)' : 'var(--sk-elevated)', color: tab === t.id ? '#fff' : 'var(--sk-fg3)' }}>
                                    {t.count}
                                </span>
                            )}
                        </button>
                    ))}
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--sk-fg3)' }}>
                        <kbd style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 4px', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10, color: 'var(--sk-fg2)', background: 'var(--sk-elevated)', border: '1px solid var(--sk-border-d)', borderRadius: 3 }}>[</kbd>
                        <kbd style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 4px', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10, color: 'var(--sk-fg2)', background: 'var(--sk-elevated)', border: '1px solid var(--sk-border-d)', borderRadius: 3 }}>]</kbd>
                        <span>切换版本</span>
                    </div>
                </div>

                {/* Content */}
                <div className="sk-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: 24, background: 'var(--sk-canvas)' }}>
                    {!current ? (
                        <div style={{ textAlign: 'center', padding: 48, color: 'var(--sk-fg3)', fontSize: 12 }}>
                            {versionsLoading ? '加载中…' : '版本不存在'}
                        </div>
                    ) : (
                        <>
                            {tab === 'overview' && (
                                <TabOverview
                                    skill={skill}
                                    version={current}
                                    versions={versions}
                                    versionDetail={versionDetail}
                                    evalSummary={evalSummary}
                                    analysisHealth={analysisHealth}
                                    parsedFlow={parsedFlow}
                                    flowLoading={flowLoading}
                                    onParseFlow={handleParseFlow}
                                    onJumpTab={setTab}
                                />
                            )}
                            {tab === 'versions' && (
                                <TabHistory
                                    skillId={skill.id}
                                    user={user}
                                    versions={versions}
                                    currentVersion={currentVersion}
                                    activeVersion={activeVersion}
                                    onSelect={(v) => { setCurrentVersion(v); setTab('overview'); }}
                                    onActivate={handleActivate}
                                    onDelete={handleDelete}
                                />
                            )}
                            {tab === 'content' && (
                                <TabContent
                                    skillId={skill.id}
                                    user={user}
                                    version={current}
                                    versionDetail={versionDetail}
                                />
                            )}
                            {tab === 'runs' && (
                                <TabRuns
                                    skillId={skill.id}
                                    user={user}
                                    currentVersion={currentVersion}
                                    onTotalChange={setRunsTotal}
                                />
                            )}
                        </>
                    )}
                </div>
            </div>
        </>
    );
}

// ───────── Catalog (exported) ─────────

export function SkillCatalogV2({ refresh, onUploadClick }: { refresh: number; onUploadClick?: () => void }) {
    const { user } = useAuth();
    const [skills, setSkills] = useState<SkillListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<SkillListItem | null>(null);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

    const fetchSkills = () => {
        if (!user) return;
        setLoading(true);
        apiFetch(`/api/skills?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then(d => {
                setSkills(Array.isArray(d) ? d : []);
            })
            .catch(() => setSkills([]))
            .finally(() => setLoading(false));
    };

    useEffect(() => { fetchSkills(); /* eslint-disable-next-line */ }, [refresh, user]);

    // Sync selected with latest data
    useEffect(() => {
        if (selected) {
            const u = skills.find(s => s.id === selected.id);
            if (u && u !== selected) setSelected(u);
            if (!u) setSelected(null);
        }
    }, [skills]); // eslint-disable-line

    const filtered = useMemo(() => {
        return skills.filter(s => {
            if (search) {
                const q = search.toLowerCase();
                if (!s.name.toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q)) return false;
            }
            const active = (s.calls7d ?? 0) > 0 || (s.agentsUsing ?? 0) > 0 || !!s.isUploaded;
            if (statusFilter === 'active' && !active) return false;
            if (statusFilter === 'inactive' && active) return false;
            return true;
        });
    }, [skills, search, statusFilter]);

    const stats = useMemo(() => {
        const totalCalls = skills.reduce((a, s) => a + (s.calls7d || 0), 0);
        const running = skills.filter(s => (s.calls7d ?? 0) > 0).length;
        const pending = skills.reduce((a, s) => {
            const q = s.qualityIssues || { high: 0, medium: 0, low: 0 };
            return a + q.high + q.medium;
        }, 0);
        return { total: skills.length, running, totalCalls, pending };
    }, [skills]);

    return (
        <div className="sk-scope">
            <style dangerouslySetInnerHTML={{ __html: SCOPED_CSS }} />

            {/* 顶部 Selector Toolbar —— 对齐 /skill-eval 的 .sa-selector：
                标题块 + 搜索 + 筛选 + inline KPI 文字 + 主操作。
                合并了之前的「badge + h1 + 描述 + 4 卡 KPI strip + 独立筛选行」5 行纵向占位。 */}
            <div className="sk-toolbar">
                <div className="sk-toolbar-title">
                    <span className="sk-toolbar-title-main">Skill 列表</span>
                    <span className="sk-toolbar-title-sub">管理本地与企业 Skill</span>
                </div>

                <input
                    className="sk-toolbar-search"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="搜索 Skill 名称、描述…"
                />

                <div className="sk-toolbar-filter" role="tablist" aria-label="按激活状态筛选">
                    {([
                        { id: 'all', label: '全部' },
                        { id: 'active', label: '已激活' },
                        { id: 'inactive', label: '未激活' },
                    ] as const).map(f => (
                        <button
                            key={f.id}
                            type="button"
                            role="tab"
                            aria-selected={statusFilter === f.id}
                            className={statusFilter === f.id ? 'on' : ''}
                            onClick={() => setStatusFilter(f.id)}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>

                <div className="sk-toolbar-meta">
                    <span className="sk-toolbar-meta-item">
                        <span className="label">Skills</span>
                        <span className="val">{stats.total}</span>
                    </span>
                    <span className="sep">·</span>
                    <span className="sk-toolbar-meta-item">
                        <span className="label">运行中</span>
                        <span className={`val ${stats.running > 0 ? 'success' : ''}`}>{stats.running}</span>
                    </span>
                    <span className="sep">·</span>
                    <span className="sk-toolbar-meta-item">
                        <span className="label">七天内调用</span>
                        <span className="val">{stats.totalCalls.toLocaleString()}</span>
                    </span>
                    <span className="sep">·</span>
                    <span className="sk-toolbar-meta-item">
                        <span className="label">待优化</span>
                        <span className={`val ${stats.pending > 0 ? 'warn' : ''}`}>{stats.pending}</span>
                    </span>
                </div>

                <div className="sk-toolbar-spacer" />

                <button type="button" className="sk-toolbar-action" onClick={onUploadClick}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    上传 Skill
                </button>
            </div>

            {/* Grid */}
            {loading ? (
                <div style={{ padding: 60, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>加载中…</div>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                    {filtered.map(skill => (
                        <SkillCard
                            key={skill.id}
                            skill={skill}
                            onOpen={() => setSelected(skill)}
                            onUploadSuccess={fetchSkills}
                        />
                    ))}
                    <button
                        type="button"
                        onClick={onUploadClick}
                        style={{
                            borderRadius: 12,
                            border: '1px dashed var(--sk-border-s)',
                            background: 'rgba(0,0,0,.015)',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                            gap: 8, padding: '40px 20px', cursor: 'pointer', color: 'var(--sk-fg3)',
                            alignSelf: 'stretch',
                        }}
                    >
                        <div style={{ width: 40, height: 40, borderRadius: 999, border: '1px dashed var(--sk-border-s)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>+</div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>上传新的 Skill</div>
                        <div style={{ fontSize: 10 }}>选择本地文件夹或导入企业 Skill</div>
                    </button>
                    {filtered.length === 0 && !loading && (
                        <div style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center', color: 'var(--sk-fg3)', fontSize: 12 }}>
                            {search || statusFilter !== 'all' ? '没有匹配的 Skill' : '尚未上传任何 Skill'}
                        </div>
                    )}
                </div>
            )}

            {selected && (
                <SkillDrawer
                    skill={selected}
                    user={user || null}
                    onClose={() => setSelected(null)}
                    onChanged={fetchSkills}
                />
            )}
        </div>
    );
}
