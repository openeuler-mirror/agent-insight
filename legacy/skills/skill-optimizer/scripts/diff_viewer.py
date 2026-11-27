#!/usr/bin/env python3
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Generate a self-contained HTML diff viewer for skill optimization iterations.

Uses diff2html (via CDN) for rendering — gets us side-by-side, word-level
highlight, file collapse, synchronized scroll, syntax highlight for free.

Python side: compute unified diffs + content-addressed dedup.
Browser side: diff2html renders, custom shell handles version selection.

Usage:
    python generate_diff_viewer.py --snapshots ./snapshots -o diff.html
    python generate_diff_viewer.py --base ./v0 --current ./v1 -o diff.html

No dependencies beyond the Python stdlib.
"""

import argparse
import difflib
import hashlib
import json
import os
import re
import sys
from pathlib import Path

TEXT_EXTENSIONS = {
    ".md", ".txt", ".json", ".csv", ".py", ".js", ".ts", ".tsx", ".jsx",
    ".yaml", ".yml", ".xml", ".html", ".css", ".sh", ".rb", ".go", ".rs",
    ".java", ".c", ".cpp", ".h", ".hpp", ".sql", ".r", ".toml", ".cfg",
    ".ini", ".env", ".mjs", ".cjs", ".lua", ".pl", ".swift", ".kt",
}
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", ".opt", "snapshots", ".DS_Store"}
ALWAYS_INCLUDE = {"SKILL.md", "Makefile", "Dockerfile", "LICENSE", "LICENSE.txt"}


def collect_files(directory: Path) -> dict[str, str]:
    files = {}
    if not directory.is_dir():
        return files
    for root, dirs, filenames in os.walk(directory):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for fname in sorted(filenames):
            fpath = Path(root) / fname
            rel = str(fpath.relative_to(directory))
            if fpath.suffix.lower() in TEXT_EXTENSIONS or fname in ALWAYS_INCLUDE:
                try:
                    files[rel] = fpath.read_text(errors="replace")
                except OSError:
                    files[rel] = "(Error reading file)"
    return files


def version_sort_key(name: str):
    parts = re.split(r'[.\-_]', name.lstrip('v'))
    result = []
    for p in parts:
        try:
            result.append((0, int(p)))
        except ValueError:
            result.append((1, p))
    return result


def discover_snapshots(snapshots_dir: Path) -> list[dict]:
    versions = []
    for child in sorted(snapshots_dir.iterdir(), key=lambda p: version_sort_key(p.name)):
        if child.is_dir() and not child.name.startswith('.'):
            if any(child.rglob('*')):
                versions.append({"label": child.name, "files": collect_files(child)})
    return versions


def compute_unified_diff(base_files: dict[str, str], cur_files: dict[str, str]) -> str:
    """Compute a combined unified diff string (git-diff style) for all changed files."""
    all_paths = sorted(set(base_files.keys()) | set(cur_files.keys()))
    parts = []

    for path in all_paths:
        b = base_files.get(path, "")
        c = cur_files.get(path, "")
        if b == c:
            continue

        b_lines = b.splitlines(keepends=True) if b else []
        c_lines = c.splitlines(keepends=True) if c else []

        # Ensure lines end with newline for clean diff
        if b_lines and not b_lines[-1].endswith('\n'):
            b_lines[-1] += '\n'
        if c_lines and not c_lines[-1].endswith('\n'):
            c_lines[-1] += '\n'

        from_path = f"a/{path}" if b else "/dev/null"
        to_path = f"b/{path}" if c else "/dev/null"

        diff_lines = list(difflib.unified_diff(
            b_lines, c_lines,
            fromfile=from_path,
            tofile=to_path,
        ))

        if diff_lines:
            # Add git-style header for diff2html
            parts.append(f"diff --git a/{path} b/{path}")
            if not b:
                parts.append("new file mode 100644")
            elif not c:
                parts.append("deleted file mode 100644")
            parts.extend(line.rstrip('\n') for line in diff_lines)

    return '\n'.join(parts)


def dedup_content(versions: list[dict]) -> dict:
    """Content-addressed dedup for embedding efficiency."""
    blobs: dict[str, str] = {}
    ver_refs = []
    for v in versions:
        refs = {}
        for path, content in v["files"].items():
            h = hashlib.sha256(content.encode()).hexdigest()[:12]
            blobs[h] = content
            refs[path] = h
        ver_refs.append({"label": v["label"], "files": refs})
    return {"blobs": blobs, "versions": ver_refs}


def precompute_diffs(versions: list[dict]) -> dict[str, str]:
    """Pre-compute unified diffs for adjacent version pairs (the common case).

    Returns { "0:1": "diff string", "1:2": "...", ... }
    Other pairs are computed in the browser from blobs on demand.
    """
    diffs = {}
    for i in range(len(versions) - 1):
        key = f"{i}:{i+1}"
        diffs[key] = compute_unified_diff(versions[i]["files"], versions[i+1]["files"])
    # Also precompute first-to-last (common for "total change" view)
    if len(versions) > 2:
        key = f"0:{len(versions)-1}"
        diffs[key] = compute_unified_diff(versions[0]["files"], versions[-1]["files"])
    return diffs


def generate_html(versions: list[dict], skill_name: str = "",
                  default_base: int = 0, default_current: int = -1) -> str:
    if default_current < 0:
        default_current = len(versions) - 1

    deduped = dedup_content(versions)
    pre_diffs = precompute_diffs(versions)

    embedded = {
        "skill_name": skill_name,
        "blobs": deduped["blobs"],
        "versions": deduped["versions"],
        "pre_diffs": pre_diffs,
        "default_base": default_base,
        "default_current": default_current,
    }
    data_json = json.dumps(embedded, ensure_ascii=False)
    return HTML_TEMPLATE.replace("/*__DIFF_DATA__*/", f"const DIFF_DATA = {data_json};")


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Skill Diff Viewer</title>

<!-- diff2html from CDN -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/github.min.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css" />
<script src="https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html-ui.min.js"></script>

<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@400;500;600;700&display=swap');

  :root {
    --bg: #ffffff;
    --surface: #f6f8fa;
    --surface-raised: #f0f2f5;
    --surface-hover: #e8ebef;
    --border: #d1d9e0;
    --border-focus: #0969da;
    --text: #1f2328;
    --text-secondary: #59636e;
    --text-dim: #8b949e;
    --add-text: #1a7f37;
    --add-badge: rgba(26,127,55,0.12);
    --del-text: #cf222e;
    --del-badge: rgba(207,34,46,0.12);
    --mod-text: #9a6700;
    --accent: #0969da;
    --confirm: #1a7f37;
    --confirm-hover: #15803d;
    --mono: 'IBM Plex Mono','Menlo','Consolas',monospace;
    --sans: 'Outfit',-apple-system,BlinkMacSystemFont,sans-serif;
    --radius-sm: 5px;
  }

  body, .toolbar, .diff-container, .toast { box-sizing:border-box; }
  * { margin:0; padding:0; }
  html, body { height:100%; }

  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    line-height: 1.55;
  }

  /* ── Toolbar ──────────────────────────────────── */
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 12px 22px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  .toolbar-section {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .logo {
    width: 28px; height: 28px;
    background: linear-gradient(135deg, var(--accent), #7c3aed);
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; color: #fff;
    flex-shrink: 0;
  }

  .toolbar-title { font-size: 15px; font-weight: 600; white-space: nowrap; }

  .version-select {
    font-family: var(--mono); font-size: 12px; font-weight: 500;
    padding: 5px 10px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-raised);
    color: var(--text); cursor: pointer; outline: none; min-width: 80px;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2359636e'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 8px center; padding-right: 24px;
  }
  .version-select:focus { border-color: var(--border-focus); }
  .version-select.base-sel { border-left: 3px solid var(--del-text); }
  .version-select.current-sel { border-left: 3px solid var(--add-text); }

  .arrow-sep { color: var(--text-dim); font-size: 16px; user-select: none; }

  .stats-pill {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 4px 12px; border-radius: 20px;
    background: var(--surface-raised); border: 1px solid var(--border);
    font-size: 11px; font-family: var(--mono); font-weight: 500;
  }
  .stat-add { color: var(--add-text); }
  .stat-del { color: var(--del-text); }
  .stat-files { color: var(--text-secondary); }

  .view-toggle {
    display: inline-flex; background: var(--bg);
    border-radius: var(--radius-sm); border: 1px solid var(--border); overflow: hidden;
  }
  .view-toggle button {
    background: none; border: none; color: var(--text-dim);
    padding: 5px 13px; font-size: 11px; font-family: var(--sans);
    font-weight: 600; cursor: pointer; transition: all 0.12s;
  }
  .view-toggle button.active { background: var(--surface-raised); color: var(--text); }
  .view-toggle button:hover:not(.active) { color: var(--text-secondary); }

  .spacer { flex: 1; }

  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 15px; border-radius: var(--radius-sm);
    font-size: 12px; font-weight: 600; font-family: var(--sans);
    cursor: pointer; border: 1px solid transparent; transition: all 0.12s;
  }
  .btn-confirm { background: var(--confirm); color: #fff; border-color: var(--confirm); }
  .btn-confirm:hover { background: var(--confirm-hover); }
  .btn-revise { background: transparent; color: var(--accent); border-color: var(--border); }
  .btn-revise:hover { background: var(--surface-hover); border-color: var(--accent); }
  .btn-revert { background: transparent; color: var(--mod-text); border-color: var(--border); }
  .btn-revert:hover { background: var(--surface-hover); border-color: var(--mod-text); }
  .action-hint { font-size: 11px; color: var(--text-dim); }

  /* ── Tabs ─────────────────────────────────────── */
  .diff-tabs {
    display: flex;
    gap: 8px;
    padding: 16px 22px 0;
    background: var(--bg);
  }
  .diff-tab {
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-family: var(--sans);
    transition: all 0.2s;
  }
  .diff-tab:hover {
    color: var(--text);
  }
  .diff-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .tab-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-raised);
    color: var(--text-dim);
    border-radius: 10px;
    padding: 2px 6px;
    font-size: 11px;
    margin-left: 6px;
    font-family: var(--mono);
  }
  .diff-tab.active .tab-badge {
    background: rgba(9, 105, 218, 0.1);
    color: var(--accent);
  }

  /* ── Diff container ───────────────────────────── */
  .diff-container {
    padding: 16px 22px 40px;
  }

  .loading {
    display: flex; align-items: center; justify-content: center;
    height: 200px; color: var(--text-dim); gap: 10px; font-size: 13px;
  }
  .spinner {
    width: 18px; height: 18px; border: 2px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty-msg {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 80px 0; color: var(--text-dim); gap: 10px;
  }
  .empty-msg .icon { font-size: 44px; opacity: 0.25; }

  .toast {
    position: fixed; bottom: 24px; left: 50%;
    transform: translateX(-50%) translateY(80px);
    background: #1f2328; border: none;
    color: #fff; padding: 10px 20px; border-radius: 8px;
    font-size: 13px; font-weight: 500; opacity: 0;
    transition: all 0.25s ease; pointer-events: none; z-index: 1000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }
  .toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* ── Custom collapse arrow ────────────────────── */
  .collapse-arrow {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 11px;
    cursor: pointer;
    padding: 2px 8px 2px 4px;
    margin-right: 4px;
    border-radius: 3px;
    transition: all 0.15s;
    line-height: 1;
    flex-shrink: 0;
  }
  .collapse-arrow:hover {
    color: var(--text);
    background: var(--surface-hover);
  }
  .collapse-arrow.is-collapsed {
    color: var(--text-secondary);
  }

  /* ── diff2html light theme ────────────────────── */

  /* Global wrapper */
  .d2h-wrapper { background: transparent !important; }

  /* File wrapper — card style */
  .d2h-file-wrapper {
    border: 1px solid var(--border) !important;
    border-radius: 8px !important;
    margin-bottom: 16px !important;
    overflow: hidden !important;
    background: var(--bg) !important;
  }

  /* File header bar */
  .d2h-file-header {
    background: var(--surface) !important;
    border-bottom: 1px solid var(--border) !important;
    padding: 10px 16px !important;
  }
  .d2h-file-name-wrapper {
    color: var(--text) !important;
    font-family: var(--mono) !important;
    font-size: 12px !important;
    font-weight: 500 !important;
  }

  /* File status tag */
  .d2h-tag {
    border-radius: 4px !important;
    font-size: 11px !important;
    padding: 2px 8px !important;
    font-weight: 600 !important;
    text-transform: uppercase !important;
  }
  .d2h-added-tag {
    background: var(--add-badge) !important;
    color: var(--add-text) !important;
    border: 1px solid var(--add-text) !important;
  }
  .d2h-deleted-tag {
    background: var(--del-badge) !important;
    color: var(--del-text) !important;
    border: 1px solid var(--del-text) !important;
  }
  .d2h-changed-tag {
    background: rgba(154, 103, 0, 0.12) !important;
    color: var(--mod-text) !important;
    border: 1px solid var(--mod-text) !important;
  }
  .d2h-moved-tag {
    background: var(--surface-hover) !important;
    color: var(--text-secondary) !important;
    border: 1px solid var(--border) !important;
  }

  .file-header-stats {
    display: inline-flex;
    gap: 8px;
    margin-left: 12px;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
  }
  .file-header-stats .stat-add { color: var(--add-text); }
  .file-header-stats .stat-del { color: var(--del-text); }

  /* Collapse / toggle button */
  .d2h-file-collapse {
    color: var(--text-secondary) !important;
    cursor: pointer !important;
    display: flex !important;
  }
  .d2h-file-collapse:hover { color: var(--text) !important; }
  .d2h-file-collapse-input + label { color: var(--text-secondary) !important; cursor: pointer !important; }
  .d2h-file-collapse-input + label:hover { color: var(--text) !important; }

  /* Diff body */
  .d2h-file-diff, .d2h-file-side-diff {
    background: var(--bg) !important;
    overflow-x: auto !important;
  }

  /* Table */
  .d2h-diff-table {
    font-family: var(--mono) !important;
    font-size: 12.5px !important;
    border-collapse: collapse !important;
  }

  /* Context lines (unchanged) */
  .d2h-code-line-ctn {
    color: var(--text) !important;
  }
  .d2h-code-line-prefix {
    color: var(--text-dim) !important;
    user-select: none !important;
  }

  /* Line numbers — fix positioning & remove white bg bleed */
  .d2h-code-linenumber,
  .d2h-code-side-linenumber {
    background: var(--surface) !important;
    color: var(--text-dim) !important;
    border-right: 1px solid var(--border) !important;
    font-size: 11px !important;
    cursor: default !important;
  }

  /* ── Additions ──────────────────────── */
  td.d2h-ins {
    background-color: #dafbe1 !important;
  }
  .d2h-ins .d2h-code-line-ctn {
    color: #1a4731 !important;
  }
  .d2h-ins .d2h-code-line-prefix {
    color: #1a7f37 !important;
  }
  td.d2h-ins.d2h-code-linenumber,
  td.d2h-ins.d2h-code-side-linenumber {
    background-color: #c6efce !important;
    color: #1a7f37 !important;
    border-right-color: #a7f3d0 !important;
  }
  /* Word-level add highlight */
  .d2h-ins .d2h-change,
  ins.d2h-change {
    background: #abf2bc !important;
    color: #1a4731 !important;
    text-decoration: none !important;
    border-radius: 2px !important;
  }

  /* ── Deletions ──────────────────────── */
  td.d2h-del {
    background-color: #ffebe9 !important;
  }
  .d2h-del .d2h-code-line-ctn {
    color: #82071e !important;
  }
  .d2h-del .d2h-code-line-prefix {
    color: #cf222e !important;
  }
  td.d2h-del.d2h-code-linenumber,
  td.d2h-del.d2h-code-side-linenumber {
    background-color: #ffd7d5 !important;
    color: #cf222e !important;
    border-right-color: #fca5a5 !important;
  }
  /* Word-level del highlight */
  .d2h-del .d2h-change,
  del.d2h-change {
    background: #fdb8c0 !important;
    color: #82071e !important;
    text-decoration: none !important;
    border-radius: 2px !important;
  }

  /* ── Hunk info line (@@ ... @@) ─────── */
  td.d2h-info {
    background-color: #ddf4ff !important;
  }
  .d2h-info .d2h-code-line-ctn {
    color: #0969da !important;
    font-style: italic !important;
  }
  td.d2h-info.d2h-code-linenumber,
  td.d2h-info.d2h-code-side-linenumber {
    background-color: #ddf4ff !important;
    color: #0969da !important;
  }

  /* ── Empty placeholder (side-by-side) ── */
  .d2h-emptyplaceholder {
    background: var(--surface) !important;
    border-color: var(--border) !important;
  }

  /* ── File list summary ──────────────── */
  .d2h-file-list-wrapper {
    background: var(--surface) !important;
    border: 1px solid var(--border) !important;
    border-radius: 8px !important;
    margin-bottom: 16px !important;
  }
  .d2h-file-list-wrapper .d2h-file-list-header {
    color: var(--text) !important;
    font-family: var(--sans) !important;
    padding: 10px 16px !important;
  }
  .d2h-file-list-line {
    color: var(--text-secondary) !important;
    border-bottom-color: var(--border) !important;
  }
  .d2h-file-list-line a {
    color: var(--accent) !important;
    text-decoration: none !important;
  }
  .d2h-file-list-line a:hover {
    text-decoration: underline !important;
  }
  .d2h-file-switch {
    background: var(--surface-raised) !important;
    border-color: var(--border) !important;
  }

  /* ── Line Wrapping ── */
  body.wrap-lines .d2h-code-line-ctn {
    white-space: pre-wrap !important;
    word-break: break-word !important;
  }

  /* ── Table cell borders ─────────────── */
  .d2h-diff-tbody tr td {
    border-color: var(--border) !important;
  }

  .d2h-moved-tag {
    color: var(--mod-text) !important;
  }

  ::-webkit-scrollbar { width: 7px; height: 7px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }
</style>
</head>
<body>

<div class="toast" id="toast"></div>

<div class="toolbar" id="toolbar"></div>
<div id="diff-tabs-container"></div>
<div class="diff-container" id="diff-container"></div>
<div class="diff-container" id="opt-diff-container" style="display: none;"></div>

<script>
/*__DIFF_DATA__*/
</script>

<script>
(function() {
  const D = DIFF_DATA;
  const blobs = D.blobs;
  const versions = D.versions;

  let baseIdx = D.default_base;
  let curIdx = D.default_current;
  let viewMode = 'side-by-side'; // diff2html: 'side-by-side' or 'line-by-line'

  // ── Diff cache ────────────────────────────────────────
  // Pre-computed diffs from Python
  const diffCache = new Map();
  for (const [key, val] of Object.entries(D.pre_diffs)) {
    diffCache.set(key, val);
  }

  function getDiffString(bIdx, cIdx) {
    const key = bIdx + ':' + cIdx;
    if (diffCache.has(key)) return diffCache.get(key);

    // Compute on the fly from blobs using jsdiff-style unified format
    const bFiles = resolveFiles(bIdx);
    const cFiles = resolveFiles(cIdx);
    const diff = computeUnifiedDiff(bFiles, cFiles);
    diffCache.set(key, diff);
    return diff;
  }

  function resolveFiles(idx) {
    const v = versions[idx];
    const out = {};
    for (const [path, hash] of Object.entries(v.files)) {
      out[path] = blobs[hash];
    }
    return out;
  }

  // ── Browser-side unified diff (fallback for non-precomputed pairs) ──
  function computeUnifiedDiff(bFiles, cFiles) {
    const allPaths = [...new Set([...Object.keys(bFiles), ...Object.keys(cFiles)])].sort();
    const parts = [];
    for (const path of allPaths) {
      const b = bFiles[path] || '';
      const c = cFiles[path] || '';
      if (b === c) continue;
      const bLines = b ? b.split('\n') : [];
      const cLines = c ? c.split('\n') : [];
      parts.push('diff --git a/' + path + ' b/' + path);
      if (!b) parts.push('new file mode 100644');
      else if (!c) parts.push('deleted file mode 100644');
      parts.push('--- ' + (b ? 'a/' + path : '/dev/null'));
      parts.push('+++ ' + (c ? 'b/' + path : '/dev/null'));

      // Simple unified diff with context
      const hunks = computeHunks(bLines, cLines, 3);
      for (const h of hunks) parts.push(h);
    }
    return parts.join('\n');
  }

  function computeHunks(a, b, ctx) {
    // LCS-based diff — simpler than Myers, good enough for on-demand
    const n = a.length, m = b.length;
    // For very large files, fallback to full replace
    if (n + m > 15000) {
      const lines = ['@@ -1,' + n + ' +1,' + m + ' @@'];
      a.forEach(l => lines.push('-' + l));
      b.forEach(l => lines.push('+' + l));
      return lines;
    }

    // Build edit script using simple O(ND) approach
    const ops = editScript(a, b);
    const lines = [];
    // Group into hunks
    let i = 0;
    while (i < ops.length) {
      if (ops[i].t !== '=') {
        const start = Math.max(0, i - ctx);
        let end = i;
        while (end < ops.length) {
          if (ops[end].t !== '=') { i = end + 1; }
          else {
            let nc = end;
            while (nc < ops.length && ops[nc].t === '=') nc++;
            if (nc < ops.length && nc - end <= 2 * ctx) { i = nc; } else break;
          }
          end = i;
        }
        const finish = Math.min(ops.length, end + ctx);
        // Count lines
        let oS=1,nS=1,oC=0,nC=0;
        for(let j=0;j<start;j++){if(ops[j].t==='='||ops[j].t==='-')oS++;if(ops[j].t==='='||ops[j].t==='+')nS++;}
        for(let j=start;j<finish;j++){if(ops[j].t==='='||ops[j].t==='-')oC++;if(ops[j].t==='='||ops[j].t==='+')nC++;}
        lines.push('@@ -'+oS+','+oC+' +'+nS+','+nC+' @@');
        for(let j=start;j<finish;j++){
          const op=ops[j];
          lines.push(op.t==='='?' '+op.s:op.t==='-'?'-'+op.s:'+'+op.s);
        }
        i = finish;
      } else i++;
    }
    return lines;
  }

  function editScript(a, b) {
    const n=a.length, m=b.length, max=n+m, off=max;
    if (max === 0) return [];
    const v=new Int32Array(2*max+1); v[off+1]=0;
    const trace=[];
    for(let d=0;d<=max;d++){
      trace.push(v.slice());
      for(let k=-d;k<=d;k+=2){
        let x=(k===-d||(k!==d&&v[off+k-1]<v[off+k+1]))?v[off+k+1]:v[off+k-1]+1;
        let y=x-k;
        while(x<n&&y<m&&a[x]===b[y]){x++;y++;}
        v[off+k]=x;
        if(x>=n&&y>=m){
          const ops=[];
          let cx=n,cy=m;
          for(let dd=trace.length-1;dd>0;dd--){
            const vv=trace[dd-1],kk=cx-cy;
            const pk=(kk===-dd||(kk!==dd&&vv[off+kk-1]<vv[off+kk+1]))?kk+1:kk-1;
            const px=vv[off+pk],py=px-pk;
            while(cx>px&&cy>py){ops.push({t:'=',s:a[--cx]});cy--;}
            if(dd>0){cx===px?ops.push({t:'+',s:b[--cy]}):ops.push({t:'-',s:a[--cx]});}
          }
          while(cx>0&&cy>0){ops.push({t:'=',s:a[--cx]});cy--;}
          while(cx>0)ops.push({t:'-',s:a[--cx]});
          while(cy>0)ops.push({t:'+',s:b[--cy]});
          ops.reverse();
          return ops;
        }
      }
    }
    return [];
  }

  // ── Split Diff ────────────────────────────────────────
  function isOptFile(path) {
    const p = path.toLowerCase();
    return p.endsWith('diagnoses.json') || p.endsWith('optimization_report.md') || p.endsWith('meta.json');
  }

  function splitDiff(diffStr) {
    const lines = diffStr.split('\n');
    const codeDiff = [];
    const optDiff = [];
    let currentTarget = codeDiff;
    for (const l of lines) {
      if (l.startsWith('diff --git ')) {
         const match = l.match(/ b\/(.*)$/);
         const path = match ? match[1] : '';
         if (isOptFile(path)) {
           currentTarget = optDiff;
         } else {
           currentTarget = codeDiff;
         }
      }
      currentTarget.push(l);
    }
    return { code: codeDiff.join('\n'), opt: optDiff.join('\n') };
  }

  // ── Stats ─────────────────────────────────────────────
  function countStats(diffStr) {
    const lines = diffStr.split('\n');
    let adds = 0, dels = 0, files = 0;
    for (const l of lines) {
      if (l.startsWith('diff --git')) files++;
      else if (l.startsWith('+') && !l.startsWith('+++') && !l.startsWith('diff')) adds++;
      else if (l.startsWith('-') && !l.startsWith('---') && !l.startsWith('diff')) dels++;
    }
    return { files, adds, dels };
  }

  // ── Toast / sendPrompt ────────────────────────────────
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('visible');
    setTimeout(() => t.classList.remove('visible'), 2200);
  }

  function trySend(text) {
    if (typeof sendPrompt === 'function') sendPrompt(text);
    else navigator.clipboard.writeText(text)
      .then(() => showToast('Copied \u2014 paste in your chat'))
      .catch(() => showToast(text));
  }

  // ── Render ────────────────────────────────────────────
  function render() {
    renderToolbar();
    renderDiff();
  }

  function renderToolbar() {
    const tb = document.getElementById('toolbar');
    tb.innerHTML = '';

    // Logo + title
    const sec1 = mkEl('div','toolbar-section');
    const logo = mkEl('div','logo'); logo.textContent = '\u0394'; sec1.appendChild(logo);
    const title = mkEl('div','toolbar-title'); title.textContent = D.skill_name || 'Skill Diff'; sec1.appendChild(title);
    tb.appendChild(sec1);

    // Version selectors
    const sec2 = mkEl('div','toolbar-section');
    const bSel = document.createElement('select'); bSel.className = 'version-select base-sel';
    versions.forEach((v,i) => { const o=document.createElement('option'); o.value=i; o.textContent=v.label; o.selected=i===baseIdx; bSel.appendChild(o); });
    bSel.onchange = () => { baseIdx=+bSel.value; render(); };
    sec2.appendChild(bSel);
    sec2.appendChild(Object.assign(mkEl('span','arrow-sep'), {textContent:'\u2192'}));
    const cSel = document.createElement('select'); cSel.className = 'version-select current-sel';
    versions.forEach((v,i) => { const o=document.createElement('option'); o.value=i; o.textContent=v.label; o.selected=i===curIdx; cSel.appendChild(o); });
    cSel.onchange = () => { curIdx=+cSel.value; render(); };
    sec2.appendChild(cSel);
    tb.appendChild(sec2);

    // Stats
    const diffStr = getDiffString(baseIdx, curIdx);
    const split = splitDiff(diffStr);
    const stats = countStats(split.code);
    const sec3 = mkEl('div','toolbar-section');
    const pill = mkEl('div','stats-pill');
    pill.innerHTML = `<span class="stat-files">${stats.files} file${stats.files!==1?'s':''}</span><span class="stat-add">+${stats.adds}</span><span class="stat-del">\u2212${stats.dels}</span>`;
    sec3.appendChild(pill);
    tb.appendChild(sec3);

    // View toggle
    const sec4 = mkEl('div','toolbar-section');
    const tog = mkEl('div','view-toggle');
    [['line-by-line','Unified'],['side-by-side','Side-by-side']].forEach(([m,label]) => {
      const b = mkEl('button', viewMode===m?'active':'');
      b.textContent = label;
      b.onclick = () => { viewMode=m; render(); };
      tog.appendChild(b);
    });
    sec4.appendChild(tog);

    const wrapTog = mkEl('div', 'view-toggle');
    wrapTog.style.marginLeft = '12px';
    const wrapBtn = mkEl('button', document.body.classList.contains('wrap-lines') ? 'active' : '');
    wrapBtn.textContent = 'Wrap Lines';
    wrapBtn.onclick = () => {
      document.body.classList.toggle('wrap-lines');
      wrapBtn.className = document.body.classList.contains('wrap-lines') ? 'active' : '';
    };
    wrapTog.appendChild(wrapBtn);
    sec4.appendChild(wrapTog);

    tb.appendChild(sec4);

    // Spacer
    tb.appendChild(mkEl('div','spacer'));

    // Action buttons
    const sec5 = mkEl('div','toolbar-section');
    const bc = mkEl('button','btn btn-confirm');
    bc.innerHTML = '\u2713 Accept';
    bc.onclick = () => trySend('我接受本次优化（' + versions[curIdx].label + '），保存为新基线版本。');
    sec5.appendChild(bc);

    const br = mkEl('button','btn btn-revise');
    br.innerHTML = '\u270E Revise';
    br.onclick = () => trySend('我对当前版本（' + versions[curIdx].label + '）有反馈，请按如下修改：\n');
    sec5.appendChild(br);

    if (versions.length >= 2) {
      const bv = mkEl('button','btn btn-revert');
      bv.innerHTML = '\u21A9 Revert to ' + versions[baseIdx].label;
      bv.onclick = () => trySend('请回滚到 ' + versions[baseIdx].label + ' 并从该版本继续。');
      sec5.appendChild(bv);
    }

    if (typeof sendPrompt !== 'function') {
      const hint = mkEl('span','action-hint'); hint.textContent = '按钮会复制到剪贴板'; sec5.appendChild(hint);
    }
    tb.appendChild(sec5);
  }

  let currentTab = 'code'; // 'code' | 'opt'

  function switchTab(skipRedraw = false) {
    if (!skipRedraw) {
      const tabs = document.querySelectorAll('.diff-tab');
      if (tabs[0]) tabs[0].className = 'diff-tab' + (currentTab === 'code' ? ' active' : '');
      if (tabs[1]) tabs[1].className = 'diff-tab' + (currentTab === 'opt' ? ' active' : '');
    }
    document.getElementById('diff-container').style.display = currentTab === 'code' ? 'block' : 'none';
    document.getElementById('opt-diff-container').style.display = currentTab === 'opt' ? 'block' : 'none';
  }

  function renderDiff() {
    const container = document.getElementById('diff-container');
    const optContainer = document.getElementById('opt-diff-container');
    const tabsContainer = document.getElementById('diff-tabs-container');

    container.innerHTML = '';
    optContainer.innerHTML = '';
    tabsContainer.innerHTML = '';

    if (baseIdx === curIdx) {
      container.innerHTML = '<div class="empty-msg"><div class="icon">\u27F7</div><div>Same version selected \u2014 choose two different versions</div></div>';
      container.style.display = 'block';
      optContainer.style.display = 'none';
      return;
    }

    const diffStr = getDiffString(baseIdx, curIdx);
    if (!diffStr.trim()) {
      container.innerHTML = '<div class="empty-msg"><div class="icon">\u2713</div><div>Versions are identical</div></div>';
      container.style.display = 'block';
      optContainer.style.display = 'none';
      return;
    }

    const splits = splitDiff(diffStr);
    const codeStats = countStats(splits.code);
    const optStats = countStats(splits.opt);

    // Render Tabs
    const tabsDiv = mkEl('div', 'diff-tabs');
    const codeBtn = mkEl('button', 'diff-tab' + (currentTab === 'code' ? ' active' : ''));
    codeBtn.innerHTML = `Code Changes <span class="tab-badge">${codeStats.files}</span>`;
    codeBtn.onclick = () => { currentTab = 'code'; switchTab(); };
    tabsDiv.appendChild(codeBtn);

    if (optStats.files > 0) {
      const optBtn = mkEl('button', 'diff-tab' + (currentTab === 'opt' ? ' active' : ''));
      optBtn.innerHTML = `Optimization Details <span class="tab-badge">${optStats.files}</span>`;
      optBtn.onclick = () => { currentTab = 'opt'; switchTab(); };
      tabsDiv.appendChild(optBtn);
    } else if (currentTab === 'opt') {
      currentTab = 'code';
      codeBtn.className = 'diff-tab active';
    }
    tabsContainer.appendChild(tabsDiv);

    // Render diff views
    const codeTarget = document.createElement('div');
    container.appendChild(codeTarget);
    if (splits.code.trim()) {
      renderDiff2Html(codeTarget, splits.code);
    } else {
      codeTarget.innerHTML = '<div class="empty-msg"><div class="icon">\u2713</div><div>No code changes</div></div>';
    }

    const optTarget = document.createElement('div');
    optContainer.appendChild(optTarget);
    if (splits.opt.trim()) {
      renderDiff2Html(optTarget, splits.opt);
    }

    switchTab(true);
  }

  function renderDiff2Html(targetEl, diffStr) {
    const d2h = new Diff2HtmlUI(targetEl, diffStr, {
      drawFileList: true,
      fileListToggle: true,
      fileListStartVisible: true,
      fileContentToggle: true,
      matching: 'lines',
      outputFormat: viewMode,
      synchronisedScroll: true,
      highlight: true,
      stickyFileHeaders: true,
    });

    d2h.draw();
    d2h.highlightCode();

    // Inject custom collapse arrows into each file header
    targetEl.querySelectorAll('.d2h-file-wrapper').forEach(wrapper => {
      const header = wrapper.querySelector('.d2h-file-header');
      if (!header) return;

      const arrow = document.createElement('button');
      arrow.className = 'collapse-arrow';
      arrow.innerHTML = '\u25BC';
      arrow.title = 'Collapse / Expand';
      let collapsed = false;

      // Find the diff body (the content below the header)
      const diffBodies = wrapper.querySelectorAll('.d2h-file-diff, .d2h-file-side-diff');

      arrow.onclick = (e) => {
        e.stopPropagation();
        collapsed = !collapsed;
        arrow.innerHTML = collapsed ? '\u25B6' : '\u25BC';
        arrow.classList.toggle('is-collapsed', collapsed);
        diffBodies.forEach(body => {
          body.style.display = collapsed ? 'none' : '';
        });
      };

      // Also allow clicking anywhere on the header to toggle
      header.style.cursor = 'pointer';
      header.addEventListener('click', (e) => {
        // Don't toggle if clicking on the viewed checkbox or links
        if (e.target.closest('.d2h-file-collapse, a, input, label')) return;
        arrow.click();
      });

      header.insertBefore(arrow, header.firstChild);

      // --- NEW: Rename tags and inject line stats ---
      const tag = wrapper.querySelector('.d2h-tag');
      if (tag) {
        if (tag.classList.contains('d2h-changed')) tag.textContent = 'MODIFIED';
        if (tag.classList.contains('d2h-deleted')) tag.textContent = 'REMOVED';
        if (tag.classList.contains('d2h-added')) tag.textContent = 'ADDED';
        if (tag.classList.contains('d2h-moved')) tag.textContent = 'RENAMED';
      }

      let adds = 0;
      let dels = 0;
      wrapper.querySelectorAll('.d2h-code-line-prefix').forEach(p => {
         const t = p.textContent.trim();
         if (t === '+') adds++;
         else if (t === '-') dels++;
      });

      const nameWrapper = wrapper.querySelector('.d2h-file-name-wrapper');
      if (nameWrapper) {
        const statsEl = document.createElement('span');
        statsEl.className = 'file-header-stats';
        statsEl.innerHTML = `<span class="stat-add">+${adds}</span> <span class="stat-del">\u2212${dels}</span>`;
        nameWrapper.appendChild(statsEl);
      }
    });
  }

  function mkEl(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  render();
})();
</script>
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate an interactive skill diff viewer")
    parser.add_argument("old_path", type=Path, nargs="?", help="Base path (file or dir)")
    parser.add_argument("new_path", type=Path, nargs="?", help="Current path (file or dir)")
    parser.add_argument("--snapshots", type=Path, default=None)
    parser.add_argument("--base", type=Path, default=None)
    parser.add_argument("--current", type=Path, default=None)
    parser.add_argument("--base-label", type=str, default="v0", help="Label for base version")
    parser.add_argument("--current-label", type=str, default="v1", help="Label for current version")
    parser.add_argument("--title", "-t", type=str, default="Skill", help="Skill name for UI")
    parser.add_argument("--default-base", type=str, default=None, help="Label of the default base version to select in snapshots mode")
    parser.add_argument("--default-current", type=str, default=None, help="Default current version label (e.g. v1.1)")
    parser.add_argument("--output", "-o", "--static", type=Path, default=None, help="Output HTML file (if not set, opens in browser)")
    parser.add_argument("--no-open", action="store_true", help="Do not open browser even if --output is not set")
    
    args = parser.parse_args()

    old_p = args.old_path or args.base
    new_p = args.new_path or args.current
    skill_name = args.title or "Skill"

    if args.snapshots:
        snap = args.snapshots.resolve()
        if not snap.is_dir():
            print(f"Error: {snap} not a directory", file=sys.stderr); sys.exit(1)
        versions = discover_snapshots(snap)
        if len(versions) < 2:
            print(f"Error: need >= 2 versions, found {len(versions)}", file=sys.stderr); sys.exit(1)
        default_base = 0
        default_current = len(versions) - 1
        if args.default_base:
            for i, v in enumerate(versions):
                if v["label"] == args.default_base:
                    default_base = i
                    break
        if args.default_current:
            for i, v in enumerate(versions):
                if v["label"] == args.default_current:
                    default_current = i
                    break
        html = generate_html(versions, skill_name, default_base=default_base, default_current=default_current)
    elif old_p and new_p:
        bd, cd = old_p.resolve(), new_p.resolve()
        
        if bd.is_file() and cd.is_file():
            b_files = {bd.name: bd.read_text(encoding="utf-8", errors="replace")}
            c_files = {cd.name: cd.read_text(encoding="utf-8", errors="replace")}
        else:
            if not bd.is_dir() or not cd.is_dir():
                print(f"Error: both arguments must be directories, or both must be files", file=sys.stderr); sys.exit(1)
            b_files = collect_files(bd)
            c_files = collect_files(cd)
            
        versions = [
            {"label": args.base_label, "files": b_files},
            {"label": args.current_label, "files": c_files},
        ]
        html = generate_html(versions, skill_name, default_base=0, default_current=1)
    else:
        parser.print_help()
        sys.exit(1)

    if args.output:
        out = args.output.resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html, encoding="utf-8")
        print(f"Static diff written to: {out}")
    else:
        import tempfile, webbrowser
        fd, path = tempfile.mkstemp(suffix=".html", prefix="skill-diff-")
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(html)
        print(f"Opening diff in browser: file://{path}")
        if not args.no_open:
            webbrowser.open(f"file://{path}")


if __name__ == "__main__":
    main()
