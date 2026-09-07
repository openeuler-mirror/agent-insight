/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * 解析 WorkBuddy 的 SDK 会话日志（D3）：
 *   ~/.workbuddy/logs/<date>/sdk/conversations/<sessionId>.log
 *
 * 为什么需要它：trace 文件的 generation.toolInput 会被 WorkBuddy 截断在 ~100KB，
 * 长对话时当前轮的用户输入（在 messages 数组末尾）会被整段切掉，导致从 trace 里
 * 拿不到真实提问。而 SDK 日志里的 `method:requests:result` 事件带 `userContent`，
 * 是**干净、未截断、逐轮**的用户原文（req id 里内嵌该轮起始毫秒时间戳）。
 *
 * 本模块是纯函数（无 I/O），便于单测；collector 负责读文件并调用。
 */

const USER_CONTENT_MARKER = '"userContent":[{"type":"text","text":"';

/** req-1788752774543004 → 1788752774543（前 13 位毫秒时间戳）。 */
function parseReqTimeMs(requestId) {
  const m = /^req-(\d{13})/.exec(String(requestId || ""));
  return m ? Number(m[1]) : undefined;
}

/**
 * 从日志全文里抽取每个 requestId 的首个 userContent 文本。
 * @returns {Array<{requestId:string, timeMs:number|undefined, text:string}>} 按时间升序
 */
function extractSendPrompts(logText) {
  const text = String(logText || "");
  const byId = new Map();
  let i = 0;
  while (true) {
    const j = text.indexOf(USER_CONTENT_MARKER, i);
    if (j < 0) break;
    // 向前就近找 "id":"req-..."（同一条 requests:result 行内）
    const idPos = text.lastIndexOf('"id":"', j);
    let requestId;
    if (idPos >= 0 && j - idPos < 4000) {
      const s = idPos + '"id":"'.length;
      const e = text.indexOf('"', s);
      if (e > s) requestId = text.slice(s, e);
    }
    // 从 marker 末尾扫出 JSON 字符串值（处理转义）
    let k = j + USER_CONTENT_MARKER.length;
    let buf = "";
    while (k < text.length) {
      const c = text[k];
      if (c === "\\") { buf += text.slice(k, k + 2); k += 2; continue; }
      if (c === '"') break;
      buf += c; k += 1;
    }
    i = k + 1;
    if (!requestId || !requestId.startsWith("req-")) continue;
    if (byId.has(requestId)) continue;
    let value;
    try { value = JSON.parse('"' + buf + '"'); } catch { value = buf; }
    if (value) byId.set(requestId, { requestId, timeMs: parseReqTimeMs(requestId), text: value });
  }
  return [...byId.values()].sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0));
}

/**
 * 为一条 trace 选出对应轮次的用户提问：取时间上「最接近且不晚于 trace 起始 + 容差」的那条。
 * 用户提问总是略早于该轮 generation 起始，因此用 trace.startedAt 作参照。
 */
function pickPromptForTrace(prompts, traceStartMs, toleranceMs = 5000) {
  if (!Array.isArray(prompts) || prompts.length === 0) return undefined;
  const start = Number(traceStartMs);
  if (!Number.isFinite(start)) return prompts[prompts.length - 1].text;
  let chosen;
  for (const p of prompts) {
    if (p.timeMs == null) continue;
    if (p.timeMs <= start + toleranceMs) chosen = p;
    else break;
  }
  return (chosen || prompts[prompts.length - 1]).text;
}

module.exports = { extractSendPrompts, pickPromptForTrace, parseReqTimeMs };
