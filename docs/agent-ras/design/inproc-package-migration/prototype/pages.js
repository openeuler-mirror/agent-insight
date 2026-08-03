/** High-fidelity page templates (mock data) — P0–P3 */
window.Pages = (() => {
  const { page, select, btn, badge, status, relNote, dataTable, hbar, hist, fleetKpi, panel, esc } = UI;

  function dashboard() {
    const kpis = fleetKpi([
      { group: "系统", label: "总 Trace", value: "12,480", delta: "▲ 8.2% 环比", deltaDir: "up", tone: "count" },
      { group: "系统", label: "成功率", value: "94.6%", delta: "▲ 1.1% 环比", deltaDir: "up", tone: "good" },
      { group: "系统", label: "P95 端到端时延", value: "4.2s", delta: "▼ 6.4% 环比", deltaDir: "up", tone: "latency" },
      { group: "系统", label: "活跃 Agent", value: "18", delta: "▲ 2 环比", deltaDir: "", tone: "count" },
      { group: "系统", label: "活跃模型", value: "6", delta: "环比 ±0%", deltaDir: "", tone: "count" },
      { group: "工具", label: "工具调用次数", value: "48.2k", delta: "▲ 12% 环比", deltaDir: "", tone: "count" },
      { group: "工具", label: "工具调用错误率", value: "2.4%", delta: "▼ 0.4pp 环比", deltaDir: "up", tone: "error" },
      { group: "模型", label: "模型 Tokens", value: "28.4M", delta: "▲ 12% 环比", deltaDir: "", tone: "count" },
      { group: "模型", label: "模型调用次数", value: "96.1k", delta: "▲ 9% 环比", deltaDir: "", tone: "count" },
      { group: "模型", label: "缓存命中率", value: "41%", delta: "▲ 3pp 环比", deltaDir: "up", tone: "good" },
      { group: "模型", label: "总成本", value: "$186", delta: "▲ 8% 环比", deltaDir: "down", tone: "latency" },
    ]);
    const body = `
      ${relNote("弱相关：后续可把 anomaly 计数做成可选 KPI，不合并热路径。")}
      ${kpis}
      <div class="tabs" data-tabs="dash">
        <button type="button" class="tab active" data-tab="rel">可靠性</button>
        <button type="button" class="tab" data-tab="model">模型</button>
        <button type="button" class="tab" data-tab="tool">工具</button>
        <button type="button" class="tab" data-tab="agent">Agent</button>
        <button type="button" class="tab" data-tab="orch">编排</button>
        <button type="button" class="tab" data-tab="cost">成本</button>
      </div>
      <div class="tab-panels">
        <div class="tab-panel active" data-panel="rel">
          <div class="dash-grid">
            ${panel("错误率趋势", hist([
              { label: "一", n: 12 }, { label: "二", n: 18, accent: "fail" }, { label: "三", n: 9 },
              { label: "四", n: 14 }, { label: "五", n: 22, accent: "fail" }, { label: "六", n: 11 }, { label: "日", n: 8 },
            ], { height: 180 }), "按日聚合")}
            ${panel("失败 Top Agent", hbar([
              { name: "research-bot", value: 42, label: "12.4%" },
              { name: "code-fixer", value: 28, label: "8.1%" },
              { name: "doc-writer", value: 11, label: "3.2%" },
              { name: "search-sub", value: 9, label: "2.8%" },
            ], "var(--error)"), "点击可下钻 Trace")}
            ${panel("延迟分布", hist([
              { label: "<1s", n: 120 }, { label: "1-3s", n: 340 }, { label: "3-5s", n: 180 },
              { label: "5-10s", n: 90 }, { label: ">10s", n: 40, accent: "fail" },
            ], { height: 160 }))}
            ${panel("慢 Trace", dataTable(
              ["Task", "Agent", "延迟", "Tokens", "状态"],
              [
                [`<button type="button" class="link mono" data-open-trace="task_91bc0042">task_91bc0042</button>`, "code-fixer", "9.1s", "12.4k", badge("error", "fail")],
                [`<button type="button" class="link mono" data-open-trace="task_7f2a91bc">task_7f2a91bc</button>`, "research-bot", "8.4s", "18.2k", badge("ok", "ok")],
                [`<button type="button" class="link mono" data-open-trace="task_33aa1190">task_33aa1190</button>`, "doc-writer", "7.2s", "6.1k", badge("ok", "ok")],
              ]
            ))}
          </div>
        </div>
        <div class="tab-panel" data-panel="model">
          <div class="dash-grid">
            ${panel("模型调用排行", hbar([
              { name: "gpt-4.1", value: 4200, label: "4.2k" },
              { name: "gpt-4.1-mini", value: 3100, label: "3.1k" },
              { name: "bge-m3", value: 1800, label: "1.8k" },
            ]))}
            ${panel("Token 构成", hbar([
              { name: "gpt-4.1 in/out", value: 80, label: "12M/8M" },
              { name: "mini in/out", value: 50, label: "5M/3M" },
            ], "#2C7A6B"))}
          </div>
        </div>
        <div class="tab-panel" data-panel="tool">
          <div class="dash-grid">
            ${panel("工具调用排行", hbar([
              { name: "read_file", value: 820, label: "820" },
              { name: "bash", value: 410, label: "410" },
              { name: "web_search", value: 260, label: "260" },
            ]))}
            ${panel("工具成功率趋势", hist([
              { label: "一", n: 96 }, { label: "二", n: 94 }, { label: "三", n: 97 },
              { label: "四", n: 93 }, { label: "五", n: 95 },
            ], { height: 160 }))}
          </div>
        </div>
        <div class="tab-panel" data-panel="agent">
          <div class="dash-grid">
            ${panel("Agent Trace 排行", hbar([
              { name: "research-bot", value: 420, label: "420" },
              { name: "code-fixer", value: 310, label: "310" },
              { name: "doc-writer", value: 180, label: "180" },
            ]))}
            ${panel("Skill 调用", hbar([
              { name: "web-search", value: 200, label: "200" },
              { name: "code-review", value: 90, label: "90" },
            ]))}
          </div>
        </div>
        <div class="tab-panel" data-panel="orch">
          <div class="dash-grid">
            ${panel("编排复杂度分布", hist([
              { label: "1", n: 400 }, { label: "2", n: 180 }, { label: "3", n: 60 }, { label: "4+", n: 20 },
            ], { height: 200 }), "每 trace distinct Agent 数")}
            ${panel("协作网络（示意）", `
              <div style="height:200px;display:flex;align-items:center;justify-content:center;gap:24px;color:var(--foreground-muted);font-size:12px">
                <span style="padding:12px 16px;border-radius:999px;background:#1D2B45;color:#fff;font-weight:600">research-bot</span>
                <span>→</span>
                <span style="padding:10px 14px;border-radius:999px;background:#2C7A6B;color:#fff">search-sub</span>
                <span>→</span>
                <span style="padding:10px 14px;border-radius:999px;background:#C8553D;color:#fff">code-fixer</span>
              </div>`, "节点大小=中心度 · 边=派发")}
          </div>
        </div>
        <div class="tab-panel" data-panel="cost">
          <div class="dash-grid">
            ${panel("成本趋势", hist([
              { label: "一", n: 20 }, { label: "二", n: 24 }, { label: "三", n: 18 },
              { label: "四", n: 28 }, { label: "五", n: 32 }, { label: "六", n: 22 }, { label: "日", n: 16 },
            ], { height: 180 }))}
            ${panel("模型成本排行", hbar([
              { name: "gpt-4.1", value: 120, label: "$120" },
              { name: "gpt-4.1-mini", value: 48, label: "$48" },
              { name: "其他", value: 18, label: "$18" },
            ], "var(--warning)"))}
          </div>
        </div>
      </div>`;
    return page("仪表盘", body, {
      bodyClass: "wide",
      actions: `${select("窗口", "dashWin", [["1d", "近 1 天"], ["1w", "近 7 天"], ["1m", "近 30 天"]], "1w")}`,
    });
  }

  function agents() {
    const cards = [
      { name: "research-bot", plat: "opencode", layer: "main", own: "user", ver: "v3.2", rate: "91%", calls: "128", p99: "6.2s", ago: "12 分钟前", color: "#0F6E56", bg: "#E1F5EE" },
      { name: "code-fixer", plat: "opencode", layer: "main", own: "user", ver: "v1.8", rate: "96%", calls: "84", p99: "3.1s", ago: "28 分钟前", color: "#0F6E56", bg: "#E1F5EE" },
      { name: "doc-writer", plat: "openclaw", layer: "main", own: "system", ver: "v2.0", rate: "98%", calls: "41", p99: "2.4s", ago: "1 小时前", color: "var(--primary)", bg: "var(--primary-subtle)" },
      { name: "search-sub", plat: "opencode", layer: "subagent", own: "user", ver: "v1.1", rate: "94%", calls: "210", p99: "1.8s", ago: "5 分钟前", color: "#d97706", bg: "rgba(251,191,36,.12)" },
    ]
      .map(
        (a) => `
      <div class="agent-card-v2" data-ag-plat="${esc(a.plat)}" data-ag-layer="${esc(a.layer)}" data-ag-own="${esc(a.own)}">
        <div class="head">
          <div class="ico-wrap" style="background:${a.bg};color:${a.color}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div class="title-row">
              <span class="name">${esc(a.name)}</span>
              ${status("空闲", "muted")}
            </div>
            <div class="sub">${esc(a.plat)} · ${esc(a.ver)} · 上次执行 ${esc(a.ago)}</div>
            <div class="meta" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
              ${badge(a.layer)} ${badge(a.own)} ${badge(a.plat)}
            </div>
          </div>
        </div>
        <div class="metrics">
          <div><div class="m-label">成功率</div><div class="m-val">${a.rate}</div></div>
          <div><div class="m-label">今日调用</div><div class="m-val">${a.calls}</div></div>
          <div><div class="m-label">P99</div><div class="m-val">${a.p99}</div></div>
        </div>
      </div>`
      )
      .join("");

    const body = `
      ${relNote("安装相关：同一宿主可同时挂 OTel 旁路插件与 RAS L3；台账不替代环内干预。")}
      <div class="agents-shell">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-size:14px;font-weight:600">筛选 Agent</div>
            <div style="font-size:11.5px;color:var(--foreground-secondary);margin-top:4px" id="agCountHint">显示 4 / 4 个 Agent</div>
          </div>
          ${btn("清除筛选", { variant: "ghost", size: "sm", attrs: 'data-ag-clear' })}
        </div>
        <div class="agents-filter-box">
          ${select("平台", "agPlat", [["all", "全部"], ["opencode", "opencode"], ["openclaw", "openclaw"], ["hermes", "hermes"]], "all")}
          ${select("执行时间", "agTime", [["1h", "近 1 小时"], ["24h", "近 24 小时"], ["7d", "近 7 天"], ["exact", "精确时间"]], "1h")}
          ${select("排序", "agSort", [["lastExecutedDesc", "最近执行 ↓"], ["nameAsc", "名称 A→Z"]], "lastExecutedDesc")}
          ${select("层级", "agLayer", [["all", "全部"], ["main", "主 Agent"], ["subagent", "子 Agent"]], "all")}
          ${select("归属", "agOwn", [["all", "全部"], ["user", "用户"], ["system", "系统"]], "all")}
        </div>
        <div class="card-grid" style="margin-top:16px">${cards}</div>
      </div>`;
    return page("Agent 管理", body);
  }

  function spanRow({ kind, name, secondary, dur, tokens, bar, depth = 0, selected = false, id, err = false }) {
    const pad = 8 + depth * 16;
    return `
      <button type="button" class="span-row ${selected ? "selected" : ""} ${err ? "err" : ""}" data-span="${esc(id)}" style="padding-left:${pad}px">
        <span class="kind-badge kind-${esc(kind)}">${esc(kind)}</span>
        <span class="span-name">${esc(name)}${secondary ? `<span class="span-sec">${esc(secondary)}</span>` : ""}</span>
        <span class="gantt"><i style="margin-left:${bar.left}%;width:${bar.w}%"></i></span>
        <span class="span-dur">${esc(dur)}</span>
        <span class="span-tok">${esc(tokens || "")}</span>
      </button>`;
  }

  function traceDetail(task) {
    const failed = task.status === "error";
    const spans = task.spans
      .map((s, i) =>
        spanRow({
          ...s,
          selected: i === (failed ? 3 : 1),
          id: `${task.id}-${i}`,
        })
      )
      .join("");
    const detail = task.detail;
    return `
      <div class="trace-detail" data-trace-detail="${esc(task.id)}" hidden>
        <div class="trace-detail-bar">
          <button type="button" class="btn ghost sm" data-trace-back>← 返回列表</button>
          <span class="toolbar-sep"></span>
          <code class="mono" style="font-size:11px">${esc(task.id)}</code>
          ${badge(failed ? "失败" : "正常", failed ? "fail" : "ok")}
          ${badge(task.framework, "mod")}
          <span class="metric-pill"><span class="lbl">Tokens</span><span class="val">${esc(task.tokens)}</span></span>
          <span class="metric-pill"><span class="lbl">耗时</span><span class="val">${esc(task.latency)}</span></span>
          <span class="metric-pill"><span class="lbl">成本</span><span class="val">${esc(task.cost)}</span></span>
          <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
            ${btn("暂停", { variant: "outline", size: "sm", demo: true})}
            ${btn("加入评测集", { variant: "outline", size: "sm", demo: true})}
            ${btn("智能诊断", { variant: "default", size: "sm", attrs: 'data-goto="fault"' })}
            ${btn("导出 Trace", { variant: "outline", size: "sm", demo: true})}
          </div>
        </div>
        ${
          failed
            ? `<div class="failure-card">
          <div class="fc-title">失败详情</div>
          <div class="fc-body">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="color:var(--error);font-weight:600;font-size:12px">● ${esc(task.failure.type)}</span>
              ${badge(task.failure.attr)}
            </div>
            <p style="margin:6px 0 0;font-size:13px">${esc(task.failure.desc)}</p>
            <p style="margin:4px 0 0;font-size:11.5px;color:var(--foreground-muted)">上下文：${esc(task.failure.ctx)}</p>
            <p style="margin:4px 0 0;font-size:11.5px;color:var(--success)">恢复建议：${esc(task.failure.recovery)}</p>
          </div>
        </div>`
            : ""
        }
        <h2 style="margin:0 0 8px;font-size:13px;font-weight:600">执行 Trace</h2>
        <div class="trace-split">
          <div class="trace-waterfall">
            <div class="wf-hd">
              <span>Span</span>
              <span style="margin-left:auto">Timeline</span>
              <span style="width:48px;text-align:right">Dur</span>
              <span style="width:44px;text-align:right">Tok</span>
            </div>
            ${spans}
          </div>
          <div class="trace-span-detail" data-span-detail>
            <div class="tabs" data-tabs="span-${esc(task.id)}">
              <button type="button" class="tab active" data-tab="overview">概览</button>
              <button type="button" class="tab" data-tab="prompt">Prompt</button>
              <button type="button" class="tab" data-tab="timeline">输入/输出</button>
              <button type="button" class="tab" data-tab="skills">Skills</button>
            </div>
            <div class="tab-panels">
              <div class="tab-panel active" data-panel="overview">
                <div class="detail-kv"><span>Kind</span><strong>${esc(detail.kind)}</strong></div>
                <div class="detail-kv"><span>Name</span><strong>${esc(detail.name)}</strong></div>
                <div class="detail-kv"><span>Duration</span><strong>${esc(detail.dur)}</strong></div>
                <div class="detail-kv"><span>Tokens</span><strong>${esc(detail.tokens)}</strong></div>
                <div class="detail-kv"><span>Model</span><strong>${esc(detail.model)}</strong></div>
                <pre class="code-block" style="margin-top:10px">${esc(detail.args)}</pre>
              </div>
              <div class="tab-panel" data-panel="prompt">
                <div class="prompt-msg"><div class="pm-role">system</div><pre class="pm-body">${esc(detail.prompt.system)}</pre></div>
                <div class="prompt-msg"><div class="pm-role">user</div><pre class="pm-body">${esc(detail.prompt.user)}</pre></div>
                <div class="prompt-msg"><div class="pm-role">assistant</div><pre class="pm-body">${esc(detail.prompt.assistant)}</pre></div>
              </div>
              <div class="tab-panel" data-panel="timeline">
                <div class="detail-kv"><span>Input</span></div>
                <pre class="code-block">${esc(detail.io.input)}</pre>
                <div class="detail-kv" style="margin-top:10px"><span>Output</span></div>
                <pre class="code-block">${esc(detail.io.output)}</pre>
              </div>
              <div class="tab-panel" data-panel="skills">
                ${
                  detail.skills.length
                    ? detail.skills
                        .map((s) => `<div class="skill-row" style="border:0;padding:8px 0"><div class="skill-ico">${esc(s.slice(0, 2).toUpperCase())}</div><div><strong>${esc(s)}</strong><div style="font-size:11px;color:var(--foreground-muted)">reported in session</div></div></div>`)
                        .join("")
                    : `<p style="color:var(--foreground-muted);font-size:12px">本 Trace 未报告 Skill 调用</p>`
                }
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function trace() {
    const TRACE_MOCK = [
      {
        id: "task_7f2a91bc",
        agent: "research-bot",
        status: "ok",
        latency: "4.8s",
        tools: "12",
        llm: "2",
        framework: "opencode",
        own: "user",
        time: "15:41:02",
        tokens: "8,420",
        cost: "$0.042",
        rasSessionId: "opencode:ses_7f2a",
        ras: [
          {
            kind: "llm_thinking_dead_loop",
            label: "思考死循环",
            severity: "high",
            summary: "语义判定：思考内容在同一论点上反复循环，无推进。",
            actions: ["abort_stream", "emit_notice", "push_steering"],
            notice: "检测到思考死循环，已请求中止当前生成。",
          },
        ],
        spans: [
          { kind: "task", name: "research-bot", secondary: "修复文档引用", dur: "4.8s", tokens: "8.4k", bar: { left: 0, w: 100 }, depth: 0 },
          { kind: "user", name: "user", secondary: "整理 RFC 引用", dur: "—", tokens: "", bar: { left: 0, w: 2 }, depth: 1 },
          { kind: "llm", name: "gpt-4.1", secondary: "plan", dur: "1.2s", tokens: "3.1k", bar: { left: 2, w: 24 }, depth: 1 },
          { kind: "tool", name: "web_search", secondary: "agent reliability", dur: "0.8s", tokens: "", bar: { left: 28, w: 16 }, depth: 1 },
          { kind: "tool", name: "read_file", secondary: "docs/rfc.md", dur: "0.1s", tokens: "", bar: { left: 46, w: 4 }, depth: 1 },
          { kind: "llm", name: "gpt-4.1", secondary: "final", dur: "2.1s", tokens: "5.3k", bar: { left: 52, w: 44 }, depth: 1 },
        ],
        detail: {
          kind: "llm",
          name: "gpt-4.1 · plan",
          dur: "1.2s",
          tokens: "3,120",
          model: "gpt-4.1",
          args: '{\n  "temperature": 0.2,\n  "max_tokens": 2048\n}',
          prompt: {
            system: "You are a research assistant.",
            user: "整理 RFC 引用并给出摘要。",
            assistant: "我将先检索相关资料，再阅读本地 RFC 文档…",
          },
          io: { input: "整理 RFC 引用并给出摘要。", output: "## 摘要\n1. …\n2. …" },
          skills: ["web-search", "doc-summarize"],
        },
        failure: null,
      },
      {
        id: "task_91bc0042",
        agent: "code-fixer",
        status: "error",
        latency: "9.1s",
        tools: "28",
        llm: "4",
        framework: "opencode",
        own: "user",
        time: "15:38:11",
        tokens: "12,400",
        cost: "$0.071",
        rasSessionId: "opencode:ses_91bc",
        ras: [
          {
            kind: "repeat_tool_call",
            label: "工具重复调用",
            severity: "medium",
            summary: "工具 read_file 连续重复调用，参数相同。",
            actions: ["emit_notice"],
            notice: "检测到工具重复调用，请改用已有内容继续。",
          },
        ],
        spans: [
          { kind: "task", name: "code-fixer", secondary: "修复 import 循环", dur: "9.1s", tokens: "12.4k", bar: { left: 0, w: 100 }, depth: 0 },
          { kind: "user", name: "user", secondary: "修复 import 循环", dur: "—", tokens: "", bar: { left: 0, w: 2 }, depth: 1 },
          { kind: "llm", name: "gpt-4.1", secondary: "plan", dur: "0.9s", tokens: "2.0k", bar: { left: 2, w: 10 }, depth: 1 },
          { kind: "tool", name: "read_file", secondary: "src/a.ts · ×4 重复", dur: "0.4s", tokens: "", bar: { left: 14, w: 8 }, depth: 1, err: true },
          { kind: "tool", name: "read_file", secondary: "src/a.ts", dur: "0.1s", tokens: "", bar: { left: 24, w: 3 }, depth: 2, err: true },
          { kind: "tool", name: "read_file", secondary: "src/a.ts", dur: "0.1s", tokens: "", bar: { left: 28, w: 3 }, depth: 2, err: true },
          { kind: "llm", name: "gpt-4.1", secondary: "残缺结论", dur: "1.5s", tokens: "4.2k", bar: { left: 70, w: 28 }, depth: 1 },
        ],
        detail: {
          kind: "tool",
          name: "read_file",
          dur: "0.4s (streak×4)",
          tokens: "—",
          model: "—",
          args: '{\n  "path": "src/a.ts"\n}',
          prompt: {
            system: "(tool span — 见输入/输出)",
            user: "修复 import 循环",
            assistant: "先读取 src/a.ts …",
          },
          io: {
            input: '{"path":"src/a.ts"}',
            output: "ERROR: identical repeated call (streak=4)",
          },
          skills: [],
        },
        failure: {
          type: "tool_error",
          attr: "tool",
          desc: "工具 read_file 连续 4 次相同参数调用，任务偏离目标。",
          ctx: "step 3–6 · code-fixer",
          recovery: "停止重复读取，基于已有内容继续修改。",
        },
      },
    ];

    const moreRows = [
      ["task_33aa1190", "doc-writer", "ok", "2.1s", "5", "1", "openclaw", "system", "15:20:03"],
      ["task_ab12ff01", "research-bot", "ok", "3.4s", "8", "1", "opencode", "user", "14:55:41"],
      ["task_cc880011", "search-sub", "ok", "1.2s", "3", "0", "opencode", "user", "14:40:12"],
      ["task_dd991122", "code-fixer", "error", "11.0s", "33", "6", "opencode", "user", "14:12:55"],
    ];

    const rows = [
      ...TRACE_MOCK.map((t) => [
        "<input type='checkbox'/>",
        `<button type="button" class="link mono" data-trace-open="${esc(t.id)}">${esc(t.id)}</button>`,
        t.agent,
        badge(t.status === "ok" ? "ok" : "error", t.status === "ok" ? "ok" : "fail"),
        t.latency,
        t.tools,
        t.llm,
        t.framework,
        t.own,
        t.time,
      ]),
      ...moreRows.map((r) => [
          "<input type='checkbox'/>",
          `<button type="button" class="link mono" data-trace-open="${esc(r[0])}">${esc(r[0])}</button>`,
          r[1],
          badge(r[2] === "ok" ? "ok" : "error", r[2] === "ok" ? "ok" : "fail"),
          r[3],
          r[4],
          r[5],
          r[6],
          r[7],
          r[8],
        ]),
    ];

    // lightweight detail for rows without full mock
    const extraDetails = moreRows
      .map((r) =>
        traceDetail({
          id: r[0],
          agent: r[1],
          status: r[2],
          latency: r[3],
          framework: r[6],
          tokens: "2,100",
          cost: "$0.01",
          spans: [
            { kind: "task", name: r[1], secondary: r[0], dur: r[3], tokens: "2.1k", bar: { left: 0, w: 100 }, depth: 0 },
            { kind: "user", name: "user", secondary: "…", dur: "—", tokens: "", bar: { left: 0, w: 4 }, depth: 1 },
            { kind: "llm", name: "gpt-4.1", secondary: "reply", dur: r[3], tokens: "2.1k", bar: { left: 10, w: 80 }, depth: 1, err: r[2] === "error" },
          ],
          detail: {
            kind: "llm",
            name: "gpt-4.1",
            dur: r[3],
            tokens: "2,100",
            model: "gpt-4.1",
            args: "{}",
            prompt: { system: "…", user: "…", assistant: "…" },
            io: { input: "…", output: r[2] === "error" ? "ERROR" : "OK" },
            skills: [],
          },
          failure:
            r[2] === "error"
              ? { type: "timeout", attr: "system", desc: "执行超时", ctx: r[0], recovery: "提高超时阈值" }
              : null,
        })
      )
      .join("");

    const body = `
      ${relNote("链路追踪页面，显示 Agent 执行轨迹和 Span 详情。")}
      <div id="traceListView">
        <div class="stat-grid">
          <div class="stat-card"><div class="label">Traces</div><div class="value">1,284</div></div>
          <div class="stat-card error"><div class="label">失败</div><div class="value">68</div></div>
          <div class="stat-card"><div class="label">平均延迟</div><div class="value">3.6s</div></div>
          <div class="stat-card"><div class="label">工具错误率</div><div class="value">2.1%</div></div>
        </div>
        <div class="trace-search">
          <input placeholder="搜索 query / task id / agent…" value="" />
          <button type="button" class="btn outline sm">+ 过滤条件</button>
        </div>
        <div class="toolbar">
          <button type="button" class="btn outline sm" id="btnToggleTraceFilters">过滤</button>
          <span class="toolbar-sep"></span>
          ${select("归属", "trOwn", [["all", "全部"], ["user", "用户"], ["system", "系统"]])}
          ${select("状态", "trSt", [["all", "全部"], ["ok", "成功"], ["error", "失败"]])}
          ${select("时间", "trTime", [["all", "全部"], ["1h", "近 1h"], ["24h", "近 24h"], ["7d", "近 7d"]], "24h")}
          ${select("框架", "trFw", [["all", "全部"], ["opencode", "opencode"], ["openclaw", "openclaw"]])}
          ${select("主 Agent", "trAg", [["all", "全部"], ["research-bot", "research-bot"], ["code-fixer", "code-fixer"]])}
          ${select("范围", "trScope", [["root", "仅主 Agent"], ["subagent", "仅子 Agent"], ["all", "主 + 子"]], "root")}
          ${btn("重置筛选", { variant: "ghost", size: "sm", demo: true})}
        </div>
        <div class="trace-main-row">
          <aside class="filter-aside hidden" id="traceFilterAside">
            <div class="panel-hd">过滤器</div>
            <div class="panel-bd" style="font-size:12px;color:var(--foreground-secondary);line-height:1.7">
              <div><strong>Agent</strong> = any</div>
              <div><strong>Status</strong> = any</div>
              <div><strong>Latency</strong> ≥ 0</div>
              <div style="margin-top:10px">${btn("添加子句", { variant: "outline", size: "sm", demo: true})}</div>
            </div>
          </aside>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;flex-wrap:wrap">
              <h2 style="margin:0;font-size:13px;font-weight:600">Trace 列表 <span style="color:var(--foreground-muted);font-weight:400">1,284</span></h2>
              <div style="display:flex;gap:8px">
                ${btn("列设置", { variant: "outline", size: "sm", demo: true})}
                ${btn("加入评测数据集", { variant: "default", size: "sm", demo: true})}
              </div>
            </div>
            ${dataTable(["", "Task ID", "Agent", "状态", "延迟", "工具", "LLM", "框架", "归属", "时间"], rows)}
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">
              <span style="color:var(--foreground-muted)">第 1–20 / 1284 · 每页 20</span>
              <div style="display:flex;gap:8px">${btn("上一页", { variant: "outline", size: "sm", demo: true})}${btn("下一页", { variant: "outline", size: "sm", demo: true})}</div>
            </div>
          </div>
        </div>
      </div>
      <div id="traceDetailHost">
        ${TRACE_MOCK.map(traceDetail).join("")}
        ${extraDetails}
      </div>`;
    return page("链路追踪", body, {
      actions: `${btn("导入 Trace", { variant: "outline", size: "sm", demo: true})}`,
    });
  }

  function versionAnalysis() {
    return page(
      "版本分析",
      `${relNote("正交：版本趋势不消费 EventBus。")}
      <div class="toolbar">
        ${select("Agent", "vaAg", [["research-bot", "research-bot"], ["code-fixer", "code-fixer"]], "research-bot")}
        ${select("基线", "vaBase", [["v2", "v2"], ["v1", "v1"]], "v2")}
        ${select("候选", "vaCand", [["v3", "v3"], ["v2.1", "v2.1"]], "v3")}
        ${select("窗口", "vaWin", [["1w", "近 7 天"], ["1m", "近 30 天"]], "1w")}
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">候选成功率</div><div class="value" style="color:var(--success)">95.2%</div></div>
        <div class="stat-card"><div class="label">基线成功率</div><div class="value">91.0%</div></div>
        <div class="stat-card"><div class="label">延迟 Δ</div><div class="value" style="color:var(--success)">-12%</div></div>
        <div class="stat-card"><div class="label">配对样本</div><div class="value">640</div></div>
      </div>
      <div class="dash-grid">
        ${panel("成功率对比", hist([
          { label: "W1", n: 88 }, { label: "W2", n: 90 }, { label: "W3", n: 92 }, { label: "W4", n: 95 },
        ], { height: 160 }), "候选 v3")}
        ${panel("失败类型变化", hbar([
          { name: "tool_error", value: -8, label: "-8" },
          { name: "judge_fail", value: -3, label: "-3" },
          { name: "timeout", value: 1, label: "+1" },
        ], "var(--primary)"))}
      </div>`
    );
  }

  function fault() {
    const cases = [
      {
        id: "task_91bc",
        traceId: "task_91bc0042",
        type: "tool_error",
        agent: "code-fixer",
        meta: "code-fixer · 15:38 · 9.1s",
        brief: "工具 read_file 连续失败",
        title: "故障路径 · task_91bc",
        sub: "code-fixer · opencode · user",
        summary: "工具 <code>read_file</code> 连续 4 次相同参数调用，任务偏离目标。",
        attr: "tool",
        recovery: "retry_with_cache",
        ras: "repeat_tool_call",
        steps: [
          ["user", "修复 import 循环 · 15:38:11", false],
          ["llm", "规划：先读相关文件 · 820ms", false],
          ["tool · read_file", "重复 ×4 · 同参 · error", true],
          ["llm", "输出残缺结论 · step 7", false],
        ],
        raw: '[{"role":"user","content":"修复 import 循环"}, {"role":"assistant","tool_calls":[...]}]',
      },
      {
        id: "task_7f2a",
        traceId: "task_7f2a91bc",
        type: "judge_fail",
        agent: "research-bot",
        meta: "research-bot · 15:41 · 4.8s",
        brief: "答案判错",
        title: "故障路径 · task_7f2a",
        sub: "research-bot · opencode · user",
        summary: "最终答案未覆盖关键约束，评测判错。",
        attr: "judge",
        recovery: "rewrite_answer",
        ras: null,
        steps: [
          ["user", "整理 RFC 引用", false],
          ["llm", "检索 + 摘要", false],
          ["llm", "最终答案 · judge=fail", true],
        ],
        raw: '[{"role":"user","content":"整理 RFC"}, {"role":"assistant","content":"..."}]',
      },
      {
        id: "task_cc01",
        traceId: null,
        type: "timeout",
        agent: "doc-writer",
        meta: "doc-writer · 14:12 · 30s",
        brief: "执行超时",
        title: "故障路径 · task_cc01",
        sub: "doc-writer · openclaw · system",
        summary: "端到端超过 30s 预算，任务被中止。",
        attr: "system",
        recovery: "raise_timeout",
        ras: null,
        steps: [
          ["user", "写长文档", false],
          ["llm", "长时间生成…", true],
        ],
        raw: '[{"role":"user","content":"写长文档"}]',
      },
      {
        id: "task_dd99",
        traceId: "task_dd991122",
        type: "tool_error",
        agent: "code-fixer",
        meta: "code-fixer · 14:12 · 11s",
        brief: "bash 非零退出",
        title: "故障路径 · task_dd99",
        sub: "code-fixer · opencode · user",
        summary: "工具 <code>bash</code> 返回 exit 1，未处理错误继续推进。",
        attr: "tool",
        recovery: "surface_stderr",
        ras: "tool_call_loop",
        steps: [
          ["user", "跑测试", false],
          ["tool · bash", "npm test · exit 1", true],
          ["llm", "忽略错误继续", false],
        ],
        raw: '[{"role":"user","content":"跑测试"}]',
      },
    ];

    const list = cases
      .map(
        (c, i) => `
      <button type="button" class="fault-item ${i === 0 ? "active" : ""}" data-fault-id="${esc(c.id)}" data-fault-type="${esc(c.type)}" data-fault-agent="${esc(c.agent)}">
        <div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(c.id)}</strong>${badge(c.type, c.type === "judge_fail" ? "warn" : "fail")}</div>
        <div style="margin-top:4px;color:var(--foreground-muted)">${esc(c.meta)}</div>
        <div style="margin-top:4px;font-size:11.5px;color:var(--foreground-secondary)">${esc(c.brief)}</div>
      </button>`
      )
      .join("");

    const panels = cases
      .map(
        (c, i) => `
      <div class="fault-detail" data-fault-panel="${esc(c.id)}" ${i === 0 ? "" : "hidden"}>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap">
          <div>
            <h2 style="margin:0;font-size:15px">${esc(c.title)}</h2>
            <div style="font-size:12px;color:var(--foreground-muted);margin-top:4px">${esc(c.sub)}</div>
          </div>
          ${status("已诊断", "success")}
        </div>
        <div class="panel" style="margin-bottom:12px">
          <div class="panel-hd">归因摘要</div>
          <div class="panel-bd">
            <p style="margin:0 0 8px">${c.summary}</p>
            <div style="display:flex;gap:6px;flex-wrap:wrap">${badge("attribution: " + c.attr)} ${badge("recovery: " + c.recovery)}</div>
            ${
              c.ras
                ? `<p style="margin:10px 0 0;font-size:12px;color:var(--foreground-muted)">同类环内 kind：<code>${esc(c.ras)}</code> · 在链路追踪详情「环内检测」区查看</p>`
                : `<p style="margin:10px 0 0;font-size:12px;color:var(--foreground-muted)">本案例偏事后评测/超时，与 RAS AnomalyKind 无直接对应。</p>`
            }
            ${
              c.traceId
                ? `<p style="margin:8px 0 0">${btn("在 Trace 中打开", { variant: "outline", size: "sm", attrs: `data-open-trace="${esc(c.traceId)}"` })}</p>`
                : `<p style="margin:8px 0 0;font-size:12px;color:var(--foreground-muted)">原型未收录对应 Trace 详情 mock。</p>`
            }
          </div>
        </div>
        <div class="panel" style="margin-bottom:12px">
          <div class="panel-hd">Agent Debug（示意）</div>
          <div class="panel-bd">
            ${c.steps
              .map(
                ([k, t, err]) =>
                  `<div class="path-step ${err ? "error" : ""}"><span class="dot"></span><div><strong>${esc(k)}</strong><div style="color:${err ? "var(--error)" : "var(--foreground-muted)"}">${esc(t)}</div></div></div>`
              )
              .join("")}
          </div>
        </div>
        <div class="panel">
          <div class="panel-hd">原始交互</div>
          <div class="panel-bd"><pre class="code-block">${esc(c.raw)}</pre></div>
        </div>
      </div>`
      )
      .join("");

    return page(
      "智能诊断",
      `${relNote("易混：Fault=事后路径归因；环内 AnomalyKind 在链路追踪标识，不在本页。")}
      <div class="toolbar" style="margin-bottom:0;padding:0 0 12px">
        ${select("时间", "ftTime", [["24h", "近 24h"], ["7d", "近 7d"]], "24h")}
        ${select("Agent", "ftAg", [["all", "全部 Agent"], ["code-fixer", "code-fixer"], ["research-bot", "research-bot"]], "all")}
        ${select("类型", "ftTy", [["all", "全部类型"], ["tool_error", "tool_error"], ["judge_fail", "judge_fail"], ["timeout", "timeout"]], "all")}
        <span style="margin-left:auto;color:var(--foreground-muted)">68 条失败</span>
        ${btn("打开链路追踪", { variant: "default", size: "sm", attrs: 'data-goto="trace"' })}
      </div>
      <div class="fault-layout" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;min-height:560px">
        <div class="fault-list">
          <div style="padding:10px 12px;border-bottom:1px solid var(--border);font-weight:600;font-size:12px;display:flex;justify-content:space-between">
            <span>失败执行</span><span style="color:var(--foreground-muted);font-weight:400">68</span>
          </div>
          ${list}
        </div>
        <div id="faultDetailHost" style="overflow:auto;background:var(--background-secondary)">${panels}</div>
      </div>`,
      { bodyClass: "tight" }
    );
  }

  function quality() {
    return page(
      "可靠性与性能",
      `${relNote("正交偏互补：质量读聚合表；RAS 读 EventBus。")}
      <div class="q-config">
        ${select("Agent", "qAg", [["research-bot", "research-bot"], ["code-fixer", "code-fixer"]], "research-bot")}
        ${select("窗口", "qWin", [["1d", "1 天"], ["1w", "1 周"], ["1m", "1 月"]], "1w")}
        ${select("Skill", "qSk", [["all", "全部 Skill"], ["web-search", "web-search"]], "all")}
        ${select("状态", "qSt", [["all", "全部"], ["ok", "成功"], ["fail", "失败"]])}
        <span style="margin-left:auto;font-size:11.5px;color:var(--foreground-muted)">样本 320 · 评测覆盖 72%</span>
      </div>
      <nav class="q-nav">
        <button type="button">结论</button><button type="button">维度</button><button type="button">问题</button>
        <button type="button">结果</button><button type="button">趋势</button><button type="button">过程</button><button type="button">执行</button>
      </nav>
      <section class="q-hero">
        <div style="min-width:200px">
          <div style="font-size:10.5px;color:var(--foreground-muted);font-weight:600">综合分</div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-top:6px">
            <span class="q-score">88</span><span style="color:var(--foreground-muted);font-weight:600">/100</span>
            <span style="color:var(--success);font-weight:700;font-size:12px">▲ 3.2</span>
          </div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${status("良好", "success")} ${badge("评测覆盖 72%")}</div>
          <div style="margin-top:10px;display:flex;gap:12px;font-size:11px">
            <div><span style="color:var(--error);font-weight:700">P0</span> 2</div>
            <div><span style="color:var(--warning);font-weight:700">P1</span> 5</div>
            <div><span style="color:var(--foreground-muted);font-weight:700">P2</span> 7</div>
          </div>
        </div>
        <div style="flex:1;min-width:220px">
          <div style="font-size:10.5px;color:var(--foreground-muted);font-weight:600">一句话判读</div>
          <p style="margin:6px 0 0;font-size:14px;font-weight:600;line-height:1.45">结果维度稳健，瓶颈在过程层的工具重复调用。</p>
          <p style="margin:8px 0 0;font-size:12px;color:var(--foreground-secondary)">建议先修 read_file 重复；对照 RAS <code>repeat_tool_call</code>。</p>
        </div>
        <div style="flex:1;min-width:240px">
          <div style="font-size:10.5px;color:var(--foreground-muted);font-weight:600;margin-bottom:8px">先修 Top 3</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px"><strong>工具重复</strong> · 影响 9 traces · ${btn("下钻", { variant: "ghost", size: "sm", attrs: 'data-goto="fault"' })}</div>
            <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px"><strong>答案偏短</strong> · 影响 3 · ${btn("下钻", { variant: "ghost", size: "sm", demo: true})}</div>
            <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px"><strong>超时</strong> · 影响 2 · ${btn("下钻", { variant: "ghost", size: "sm", demo: true})}</div>
          </div>
        </div>
      </section>
      <div class="q-dim-grid">
        <div class="q-dim"><div style="font-size:11px;color:var(--foreground-muted)">结果</div><div class="score" style="color:var(--success)">92</div><div style="font-size:11px;color:var(--foreground-muted)">覆盖 80%</div></div>
        <div class="q-dim"><div style="font-size:11px;color:var(--foreground-muted)">过程</div><div class="score" style="color:var(--warning)">81</div><div style="font-size:11px;color:var(--foreground-muted)">覆盖 95%</div></div>
        <div class="q-dim"><div style="font-size:11px;color:var(--foreground-muted)">成本</div><div class="score">86</div><div style="font-size:11px;color:var(--foreground-muted)">覆盖 100%</div></div>
      </div>
      <div class="panel" style="margin-bottom:12px"><div class="panel-hd">问题汇总</div><div class="panel-bd">
        ${dataTable(["优先级", "类型", "次数", "建议"], [
          [badge("P0", "fail"), "工具重复", "9", "对照 RAS / 优化 Skill"],
          [badge("P1", "warn"), "答案偏短", "3", "评测集增补"],
          [badge("P1", "warn"), "超时", "2", "调超时策略"],
          [badge("P2"), "路由偏移", "4", "观察"],
        ])}
      </div></div>
      <details class="q-collapse" open><summary>结果评测</summary><div class="body">${dataTable(["指标", "得分", "样本"], [["answer_correctness", "0.91", "230"], ["tool_efficiency", "0.84", "180"]])}</div></details>
      <details class="q-collapse"><summary>趋势（默认折叠）</summary><div class="body">${hist([{ label: "D1", n: 82 }, { label: "D2", n: 84 }, { label: "D3", n: 86 }, { label: "D4", n: 88 }, { label: "D5", n: 87 }, { label: "D6", n: 89 }, { label: "D7", n: 88 }], { height: 140 })}</div></details>
      <details class="q-collapse"><summary>过程证据</summary><div class="body" style="color:var(--foreground-secondary);font-size:12px">工具错误簇、重试分布等（假数据占位，对齐 ProcessPanel）。</div></details>
      <details class="q-collapse"><summary>执行得分表</summary><div class="body">${dataTable(["Execution", "结果", "过程", "成本"], [["task_7f2a", "90", "78", "85"], ["task_91bc", "70", "55", "80"]])}</div></details>`
    );
  }

  function infra() {
    const card = (ep, verdict, tone, model, slis) => `
      <div class="infra-card">
        <div style="display:flex;align-items:center;gap:9px">
          <span class="dot" style="background:${tone}"></span>
          <span style="font-weight:600;font-size:14px">${esc(ep)}</span>
          <span style="flex:1"></span>
          <span class="badge" style="color:${tone}">${esc(verdict)}</span>
        </div>
        <div style="font-size:12px;color:var(--foreground-muted)">${esc(model)} · 主动拉取 · 15s</div>
        <div class="infra-sli">
          ${slis.map((s) => `<div class="chip"><span>${esc(s.l)}</span><span>${esc(s.v)}</span></div>`).join("")}
        </div>
        <div style="font-size:12.5px;color:var(--primary);border-top:1px solid var(--border);padding-top:9px">查看详情 / 趋势 / 配置 →</div>
      </div>`;
    return page(
      "推理 Infra",
      `${relNote("正交：与环内 LLM 循环检测无直接耦合。")}
      <div class="toolbar">
        ${btn("来源管理", { variant: "outline", size: "sm", demo: true})}
        ${btn("添加来源", { variant: "default", size: "sm", demo: true})}
        <span style="margin-left:auto;color:var(--foreground-muted)">3 个来源 · 自动刷新</span>
      </div>
      <div class="infra-grid">
        ${card("http://vllm-a:8000", "健康", "var(--success)", "Qwen2.5-72B", [
          { l: "并发", v: "24" }, { l: "KV", v: "61.2%" }, { l: "gen/s", v: "180" }, { l: "TTFT p95", v: "0.42s" }, { l: "ITL p95", v: "28ms" }, { l: "Prefix", v: "72%" },
        ])}
        ${card("http://proxy-b:8080", "降级 · kv", "var(--warning)", "3 个模型", [
          { l: "并发", v: "48" }, { l: "KV", v: "91.0%" }, { l: "gen/s", v: "96" }, { l: "TTFT p95", v: "1.20s" }, { l: "ITL p95", v: "55ms" }, { l: "Prefix", v: "40%" },
        ])}
        ${card("http://127.0.0.1:9000", "空载", "var(--foreground-muted)", "mock-local", [
          { l: "并发", v: "0" }, { l: "KV", v: "0%" }, { l: "gen/s", v: "0" }, { l: "TTFT p95", v: "n/a" }, { l: "ITL p95", v: "n/a" }, { l: "Prefix", v: "n/a" },
        ])}
      </div>`
    );
  }

  function dataset() {
    return page(
      "评测数据集",
      `${relNote("远期可选：含环内异常场景的数据集可压测 RAS。")}
      <div class="toolbar">
        <input class="input" placeholder="搜索数据集…" style="min-width:220px;height:32px" />
        ${select("标签", "dsTag", [["all", "全部标签"], ["core", "core"], ["ras-related", "ras-related"]])}
        ${btn("新建数据集", { variant: "default", size: "sm", demo: true})}
        ${btn("从 Trace 回灌", { variant: "outline", size: "sm", attrs: 'data-goto="trace"' })}
      </div>
      <div class="card-grid">
        ${[
          { n: "loop-cases-v1", c: 48, t: "ras-related", d: "思考/工具循环场景", u: "昨天" },
          { n: "tool-fail-bench", c: 120, t: "fault", d: "工具失败与重试", u: "3 天前" },
          { n: "general-qa", c: 500, t: "core", d: "通用问答基线", u: "上周" },
          { n: "code-fix-set", c: 86, t: "core", d: "代码修复任务", u: "上周" },
        ]
          .map(
            (d) => `
          <div class="sk-card">
            <div class="sk-name">${esc(d.n)}</div>
            <div class="sk-desc">${esc(d.d)}</div>
            <div class="sk-foot"><span>${badge(d.t, d.t === "ras-related" ? "kind" : "")} · ${d.c} 条</span><span>${esc(d.u)}</span></div>
          </div>`
          )
          .join("")}
      </div>`
    );
  }

  function metrics() {
    return page(
      "评估器",
      `${relNote("正交：评估器 ≠ AnomalyKind。")}
      <div class="toolbar">
        <input class="input" placeholder="搜索评估器…" style="min-width:200px;height:32px" />
        ${select("类型", "mTy", [["all", "全部"], ["llm", "LLM-as-judge"], ["rule", "规则"]])}
        ${btn("新建评估器", { variant: "default", size: "sm", demo: true})}
      </div>
      <div class="model-grid">
        ${[
          { n: "answer_correctness", ty: "LLM-as-judge", st: "启用", desc: "答案正确性打分 0–1" },
          { n: "tool_efficiency", ty: "规则", st: "启用", desc: "工具调用次数与重复惩罚" },
          { n: "safety_check", ty: "分类器", st: "草稿", desc: "安全违规检测" },
          { n: "latency_budget", ty: "规则", st: "启用", desc: "端到端时延预算" },
        ]
          .map(
            (m) => `
          <div class="model-card">
            <div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(m.n)}</strong>${badge(m.st, m.st === "启用" ? "ok" : "warn")}</div>
            <div style="margin-top:6px;font-size:12px;color:var(--foreground-muted)">${esc(m.ty)}</div>
            <div style="margin-top:8px;font-size:12.5px;color:var(--foreground-secondary)">${esc(m.desc)}</div>
            <div style="margin-top:12px">${btn("编辑", { variant: "outline", size: "sm", demo: true})}</div>
          </div>`
          )
          .join("")}
      </div>`
    );
  }

  function evalPage() {
    const runs = [
      {
        id: "run_8841",
        title: "run_8841 · general-qa",
        sub: "answer_correctness · 完成 · 得分 0.91",
        sideSub: "general-qa · 完成",
        running: false,
        stats: [
          ["总数", "120", ""],
          ["成功", "109", "color:var(--success)"],
          ["失败", "11", "color:var(--error)"],
          ["均分", "0.91", ""],
        ],
        rows: [
          ["1", "如何修复循环依赖？", "0.95", badge("pass", "ok"), "4.2s"],
          ["2", "总结这篇 RFC", "0.88", badge("pass", "ok"), "6.1s"],
          ["3", "重复调用 read_file 场景", "0.42", badge("fail", "fail"), "9.0s"],
          ["4", "生成 changelog", "0.93", badge("pass", "ok"), "3.3s"],
        ],
        openTrace: "task_91bc0042",
      },
      {
        id: "run_8830",
        title: "run_8830 · tool-fail-bench",
        sub: "tool_efficiency · 运行中 · 进度 64%",
        sideSub: "tool-fail-bench · 64%",
        running: true,
        stats: [
          ["总数", "50", ""],
          ["已跑", "32", ""],
          ["失败", "7", "color:var(--error)"],
          ["当前均分", "0.71", ""],
        ],
        rows: [
          ["1", "bash 非零退出", "0.40", badge("fail", "fail"), "11s"],
          ["2", "read_file 同参重复", "0.35", badge("fail", "fail"), "9.1s"],
          ["3", "正常工具链", "0.92", badge("pass", "ok"), "2.8s"],
        ],
        openTrace: "task_dd991122",
      },
      {
        id: "run_8702",
        title: "run_8702 · loop-cases-v1",
        sub: "answer_correctness · 完成 · 得分 0.77",
        sideSub: "loop-cases-v1 · 0.77",
        running: false,
        stats: [
          ["总数", "40", ""],
          ["成功", "28", "color:var(--success)"],
          ["失败", "12", "color:var(--error)"],
          ["均分", "0.77", ""],
        ],
        rows: [
          ["1", "思考循环短样本", "0.62", badge("fail", "fail"), "5.4s"],
          ["2", "长对话无环", "0.91", badge("pass", "ok"), "4.1s"],
          ["3", "工具环检测", "0.55", badge("fail", "fail"), "8.2s"],
        ],
        openTrace: "task_7f2a91bc",
      },
    ];

    const side = runs
      .map(
        (r, i) => `
      <button type="button" class="eval-run-item ${i === 0 ? "active" : ""}" data-eval-id="${esc(r.id)}">
        <div style="font-weight:600">${esc(r.id)}</div>
        <div style="font-size:11.5px;color:var(--foreground-muted);margin-top:4px">${esc(r.sideSub)}</div>
        ${r.running ? status("运行中", "warning") : ""}
      </button>`
      )
      .join("");

    const panels = runs
      .map(
        (r, i) => `
      <div class="eval-main" data-eval-panel="${esc(r.id)}" ${i === 0 ? "" : "hidden"}>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap">
          <div>
            <div style="font-size:15px;font-weight:600">${esc(r.title)}</div>
            <div style="font-size:12px;color:var(--foreground-muted);margin-top:4px">${esc(r.sub)}</div>
          </div>
          <div style="display:flex;gap:8px">
            ${btn("打开轨迹", { variant: "outline", size: "sm", attrs: `data-open-trace="${esc(r.openTrace)}"` })}
            ${btn("删除", { variant: "ghost", size: "sm", demo: true })}
          </div>
        </div>
        <div class="stat-grid" style="grid-template-columns:repeat(4,1fr)">
          ${r.stats
            .map(
              ([label, value, style]) =>
                `<div class="stat-card"><div class="label">${esc(label)}</div><div class="value" style="${style}">${esc(value)}</div></div>`
            )
            .join("")}
        </div>
        ${dataTable(["#", "Query", "得分", "状态", "耗时"], r.rows)}
      </div>`
      )
      .join("");

    return `
      <div class="page-frame">
        ${UI.topbar({
          title: "评测执行",
          actions: `${btn("只看自动观测", { variant: "outline", size: "sm", demo: true })} ${btn("新建评测", { variant: "default", size: "sm", demo: true })}`,
        })}
        <div class="page-body canvas-flex">
          ${relNote("正交：评测编排不经 RAS；环内事件落库后在 Trace 标识。")}
          <div class="eval-layout" style="flex:1;border-top:1px solid var(--border)">
            <div id="evalMainHost" style="flex:1;min-width:0;overflow:auto">${panels}</div>
            <aside class="eval-side">
              <div class="eval-side-hd">历史任务</div>
              ${side}
            </aside>
          </div>
        </div>
      </div>`;
  }

  function skills() {
    const cards = [
      { n: "web-search", v: "v4", d: "联网检索与摘要，支持多源融合", s: "0.98", tag: "生产" },
      { n: "code-review", v: "v2", d: "代码审查清单与风险标注", s: "0.91", tag: "生产" },
      { n: "llm-loop-detection", v: "v1", d: "环内思考循环检测（L3 相关）", s: "0.81", tag: "实验" },
      { n: "doc-summarize", v: "v3", d: "长文档分层摘要", s: "0.95", tag: "生产" },
      { n: "sql-assist", v: "v1", d: "SQL 生成与解释", s: "0.87", tag: "生产" },
      { n: "test-gen", v: "v2", d: "单测生成", s: "0.84", tag: "灰度" },
    ]
      .map(
        (s) => `
      <div class="sk-card" data-sk-tag="${esc(s.tag)}" data-sk-name="${esc(s.n)}" data-sk-desc="${esc(s.d)}">
        <div style="display:flex;justify-content:space-between;gap:8px"><div class="sk-name">${esc(s.n)}</div>${badge(s.tag, s.tag === "实验" ? "kind" : s.tag === "灰度" ? "warn" : "ok")}</div>
        <div style="font-size:11px;color:var(--foreground-muted);margin-top:2px">${esc(s.v)}</div>
        <div class="sk-desc">${esc(s.d)}</div>
        <div class="sk-foot"><span>评测 <span class="val" style="font-family:var(--font-mono);font-weight:700;color:var(--foreground)">${esc(s.s)}</span></span>${btn("详情", { variant: "outline", size: "sm", demo: true })}</div>
      </div>`
      )
      .join("");
    return page(
      "Skills Hub",
      `${relNote("L3 相关：Hub 管包；HostCallback/ras-judge 仅 inproc。")}
      <div class="sk-toolbar">
        <div class="sk-toolbar-title"><div class="sk-toolbar-title-main">Skill 分析</div><div class="sk-toolbar-title-sub">本地目录</div></div>
        <input class="sk-toolbar-search" id="skSearch" placeholder="搜索 name / 描述…" />
        <div class="sk-filter">
          <button type="button" class="on" data-sk-filter="all">全部</button>
          <button type="button" data-sk-filter="生产">生产</button>
          <button type="button" data-sk-filter="灰度">灰度</button>
          <button type="button" data-sk-filter="实验">实验</button>
        </div>
        <div class="sk-meta">
          <span class="sk-toolbar-meta-item"><span class="label">共</span> <span class="val" id="skCountVal">6</span></span>
          <span class="sep">·</span>
          <span class="sk-toolbar-meta-item"><span class="label">均分</span> <span class="val success">0.89</span></span>
        </div>
        ${btn("上传 / 生成", { variant: "default", size: "sm", demo: true })}
      </div>
      <div class="sk-grid">${cards}</div>`,
      { bodyClass: "tight" }
    );
  }

  function skillGenerator() {
    return page(
      "Skills 生成",
      `${relNote("弱相关。")}
      <div class="split">
        <div class="panel"><div class="panel-hd">需求描述</div><div class="panel-bd">
          <textarea class="input" style="height:200px;width:100%;padding:12px;resize:vertical;line-height:1.5" placeholder="描述要生成的 Skill 能力、输入输出与约束…"></textarea>
          <div class="toolbar" style="margin:12px 0 0">
            ${select("模型", "sgM", [["default-chat", "default-chat"]], "default-chat")}
            ${btn("生成", { variant: "default", size: "sm", demo: true})}
          </div>
        </div></div>
        <div class="panel"><div class="panel-hd">SKILL.md 预览</div><div class="panel-bd"><pre class="code-block">---
name: example-skill
description: （假数据预览）
---

# Example Skill

## When to use
…

## Steps
1. …
</pre></div></div>
      </div>`
    );
  }

  function skillEval() {
    return page(
      "Skills 评测",
      `${relNote("弱相关：可评估环内检测 Skill；人机查看走 Trace 标识。")}
      <div class="toolbar">
        ${select("Skill", "seSk", [["all", "全部"], ["web-search", "web-search"], ["llm-loop-detection", "llm-loop-detection"]])}
        ${select("状态", "seSt", [["all", "全部"], ["done", "完成"], ["queued", "排队"]])}
        ${btn("触发评测", { variant: "default", size: "sm", demo: true})}
        ${btn("灰度评测", { variant: "outline", size: "sm", demo: true})}
      </div>
      ${dataTable(
        ["Skill", "数据集", "评估器", "得分", "状态", "时间"],
        [
          ["web-search", "search-bench", "answer_correctness", "0.94", badge("完成", "ok"), "今天"],
          ["llm-loop-detection", "loop-cases-v1", "answer_correctness", "0.81", badge("完成", "ok"), "昨天"],
          ["code-review", "cr-set", "tool_efficiency", "—", badge("排队", "warn"), "—"],
          ["doc-summarize", "general-qa", "answer_correctness", "0.95", badge("完成", "ok"), "上周"],
        ]
      )}`
    );
  }

  function skillOpt() {
    return page(
      "Skills 优化",
      `${relNote("弱相关：与 RAS 恢复策略配置分离。")}
      <div class="card-grid">
        <div class="agent-card-v2">
          <div class="title-row"><span class="name">web-search</span>${badge("可优化", "kind")}</div>
          <div class="sub">当前 v4 · 建议候选 v5 · 预估 +3%</div>
          <div class="metrics">
            <div><div class="m-label">基线</div><div class="m-val">0.98</div></div>
            <div><div class="m-label">候选</div><div class="m-val">1.01*</div></div>
            <div><div class="m-label">候选数</div><div class="m-val">2</div></div>
          </div>
          <div style="margin-top:12px">${btn("打开优化", { variant: "default", size: "sm", demo: true})}</div>
        </div>
        <div class="agent-card-v2">
          <div class="title-row"><span class="name">code-review</span>${badge("观察中")}</div>
          <div class="sub">当前 v2 · 暂无候选</div>
          <div class="metrics">
            <div><div class="m-label">基线</div><div class="m-val">0.91</div></div>
            <div><div class="m-label">候选</div><div class="m-val">—</div></div>
            <div><div class="m-label">候选数</div><div class="m-val">0</div></div>
          </div>
        </div>
        <div class="agent-card-v2">
          <div class="title-row"><span class="name">llm-loop-detection</span>${badge("实验", "kind")}</div>
          <div class="sub">环内检测 Skill · 优化走评测闭环</div>
          <div class="metrics">
            <div><div class="m-label">基线</div><div class="m-val">0.81</div></div>
            <div><div class="m-label">候选</div><div class="m-val">0.84</div></div>
            <div><div class="m-label">候选数</div><div class="m-val">1</div></div>
          </div>
        </div>
      </div>`
    );
  }

  function modelRegistry() {
    return page(
      "模型注册",
      `${relNote("间接：语义判定可能复用宿主模型。")}
      <div class="toolbar">
        <input class="input" placeholder="搜索模型…" style="min-width:200px;height:32px" />
        ${btn("添加模型", { variant: "default", size: "sm", demo: true})}
        ${btn("测试连通", { variant: "outline", size: "sm", demo: true})}
      </div>
      <div class="model-grid">
        ${[
          { n: "default-chat", p: "OpenAI-compat", id: "gpt-4.1", st: "默认", url: "https://api.example.com/v1" },
          { n: "judge", p: "OpenAI-compat", id: "gpt-4.1-mini", st: "启用", url: "https://api.example.com/v1" },
          { n: "embed", p: "local", id: "bge-m3", st: "启用", url: "http://127.0.0.1:8080" },
          { n: "vision", p: "OpenAI-compat", id: "gpt-4o", st: "停用", url: "https://api.example.com/v1" },
        ]
          .map(
            (m) => `
          <div class="model-card">
            <div style="display:flex;justify-content:space-between"><strong>${esc(m.n)}</strong>${badge(m.st, m.st === "默认" || m.st === "启用" ? "ok" : "muted")}</div>
            <div style="margin-top:8px;font-size:12px;color:var(--foreground-muted)">${esc(m.p)} · <code>${esc(m.id)}</code></div>
            <div style="margin-top:6px;font-size:11.5px;font-family:var(--font-mono);color:var(--foreground-secondary);overflow:hidden;text-overflow:ellipsis">${esc(m.url)}</div>
            <div style="margin-top:12px;display:flex;gap:8px">${btn("编辑", { variant: "outline", size: "sm", demo: true})}${btn("设为默认", { variant: "ghost", size: "sm", demo: true})}</div>
          </div>`
          )
          .join("")}
      </div>`
    );
  }

  function webSearch() {
    return page(
      "联网搜索",
      `${relNote("正交。")}
      <div class="split">
        <div class="panel"><div class="panel-hd">搜索提供方</div><div class="panel-bd">
          <div class="toolbar">
            ${select("Provider", "wsP", [["tavily", "Tavily"], ["bing", "Bing"], ["serper", "Serper"]], "tavily")}
          </div>
          <label class="field" style="display:block;margin-top:12px"><span style="font-size:11px;font-weight:600;color:var(--foreground-muted)">API Key</span>
            <input class="input" style="width:100%;margin-top:4px;height:32px" value="tvly-••••••••demo" />
          </label>
          <label class="field" style="display:block;margin-top:12px"><span style="font-size:11px;font-weight:600;color:var(--foreground-muted)">默认结果数</span>
            <input class="input" style="width:100%;margin-top:4px;height:32px" value="5" />
          </label>
          <div style="margin-top:14px;display:flex;gap:8px">${btn("保存", { variant: "default", size: "sm", demo: true})}${btn("测试搜索", { variant: "outline", size: "sm", demo: true})}</div>
        </div></div>
        <div class="panel"><div class="panel-hd">最近测试</div><div class="panel-bd">
          ${dataTable(["Query", "命中", "耗时"], [["agent reliability", "5", "320ms"], ["RAS anomaly", "5", "280ms"]])}
        </div></div>
      </div>`
    );
  }

  function versionManagement() {
    return page(
      "版本管理",
      `${relNote("正交：agent_ras 包版本独立维护。")}
      <div class="toolbar">
        ${select("组件", "vmComp", [["all", "全部组件"], ["insight", "agent-insight"], ["otel", "otel-plugin"]])}
        ${btn("刷新", { variant: "outline", size: "sm", demo: true})}
      </div>
      ${dataTable(
        ["组件", "当前版本", "渠道", "变更", "更新时间"],
        [
          ["agent-insight", "0.9.x-dev", badge("stable", "ok"), "仪表盘 / 评测", "本周"],
          ["otel-plugin", "1.2.0", badge("stable", "ok"), "ingest 稳定性", "上周"],
          ["agent_ras（迁入后）", "—", badge("bundled", "kind"), "待一期 T1", "—"],
          ["skill-catalog", "2026.07", badge("stable", "ok"), "Hub 工具条", "上周"],
        ]
      )}`
    );
  }

  function accessInstall() {
    return page(
      "安装指导",
      `${relNote("强相关 · 安装面：默认 transport http；L3 需 inproc；人机在链路追踪看 RAS 标识。")}
      <div class="install-intro">
        <p style="margin:0">按<b>项目类型</b>（而非操作系统）选择接入方式：</p>
        <ul>
          <li><span class="install-dot"></span><span><b>命令行 Agent</b>（Claude Code / OpenCode / OpenClaw 等）：运行下方一键脚本，自动配置 <code>AGENT_INSIGHT_HOST</code> 与 <code>AGENT_INSIGHT_API_KEY</code>。</span></li>
          <li><span class="install-dot"></span><span><b>LangChain / LangGraph</b> Python 项目：无需安装，只改环境变量。</span></li>
        </ul>
      </div>
      <div class="split">
        <div>
          <div class="section-hd"><span style="color:var(--primary)">▸</span> 命令行 Agent 安装 <span class="count-pill">3</span>
            <span style="flex:1"></span>
            <span style="font-size:11.5px;color:var(--foreground-muted);font-weight:400">按系统二选一</span>
          </div>
          <div class="cmd-card">
            <div class="cmd-hd">Linux / macOS <span class="cmd-hint">bash / zsh</span></div>
            <div class="install-cmd"><pre class="code-block">curl -sSf "http://insight.local/api/ingest/setup?key=ai_demo_xxx" | bash</pre>${btn("复制", { variant: "outline", size: "sm", demo: true})}</div>
          </div>
          <div class="cmd-card">
            <div class="cmd-hd">Windows (PowerShell) <span class="cmd-hint">管理员运行</span></div>
            <div class="install-cmd"><pre class="code-block">irm "http://insight.local/api/ingest/setup?key=ai_demo_xxx" | iex</pre>${btn("复制", { variant: "outline", size: "sm", demo: true})}</div>
          </div>
          <div class="section-hd"><span style="color:var(--primary)">▸</span> LangChain / LangGraph</div>
          <div class="cmd-card">
            <div class="cmd-hd">环境变量</div>
            <pre class="code-block">LANGFUSE_BASE_URL=http://insight.local
LANGFUSE_PUBLIC_KEY=demo
LANGFUSE_SECRET_KEY=ai_demo_xxxxxxxx</pre>
          </div>
          <div class="section-hd"><span style="color:var(--primary)">▸</span> RAS 安装（一期示意）</div>
          <div class="cmd-card">
            <ul class="list-muted" style="margin:0 0 10px;padding-left:18px">
              <li>通过 <code>inproc</code> (bun:ffi) + <code>ras_embed</code> 同进程工作</li>
              <li>与 OTel 插件并列；弃用原 HTTP 独立进程与静态 <code>/ui/</code></li>
            </ul>
            <pre class="code-block">insight install ras --transport inproc</pre>
            <div style="margin-top:10px">${btn("安装后打开链路追踪", { variant: "default", size: "sm", attrs: 'data-goto="trace"' })}</div>
          </div>
        </div>
        <div>
          <div class="panel" style="margin-bottom:12px"><div class="panel-hd">API Key</div><div class="panel-bd">
            <pre class="code-block">ai_demo_xxxxxxxx</pre>
            <div style="margin-top:8px">${btn("复制 Key", { variant: "outline", size: "sm", demo: true})}</div>
            <p style="color:var(--foreground-muted);margin:8px 0 0;font-size:12px">用于 ingest / 安装脚本鉴权（假数据）</p>
          </div></div>
          <div class="panel"><div class="panel-hd">文档与检查</div><div class="panel-bd" style="display:flex;flex-direction:column;gap:4px">
            ${btn("OpenCode 接入", { variant: "ghost", size: "sm", attrs: 'style="justify-content:flex-start;width:100%"', demo: true})}
            ${btn("健康检查", { variant: "ghost", size: "sm", attrs: 'style="justify-content:flex-start;width:100%"', demo: true})}
            ${btn("RAS 迁移方案", { variant: "ghost", size: "sm", attrs: 'style="justify-content:flex-start;width:100%"', demo: true})}
          </div></div>
        </div>
      </div>`
    );
  }

  function agentRasTrace() {
    // ── Mock data aligned with actual RasTraceItem interface ──
    const RAS_TRACES = [
      {
        taskId: "task_91bc0042",
        executionId: "exec_91bc",
        latestTs: "2026-07-30T15:38:11Z",
        anomalyKind: "repeat_tool_call",
        severity: "medium",
        summary: "工具 read_file 连续重复调用，参数相同。",
        eventCount: 2,
        traceStatus: "failed",
        traceStatusReason: "ras-interrupted",
        detectionLevel: "L2",
        completedAt: null,
        framework: "opencode",
        agentName: "code-fixer",
        spans: [
          { kind: "task", name: "code-fixer", secondary: "修复 import 循环", dur: "9.1s", bar: { left: 0, w: 100 }, depth: 0 },
          { kind: "user", name: "user", secondary: "修复 import 循环", dur: "—", bar: { left: 0, w: 2 }, depth: 1 },
          { kind: "llm", name: "plan", secondary: "gpt-4.1", dur: "1.2s", bar: { left: 2, w: 12 }, depth: 1, ras: "dead_loop", rasSeverity: "high", rasLabel: "思考死循环" },
          { kind: "tool", name: "read_file", secondary: "src/a.ts · ×4 重复", dur: "0.4s", bar: { left: 14, w: 8 }, depth: 1, err: true, ras: "tool_repeat", rasSeverity: "medium", rasLabel: "工具重复调用" },
          { kind: "tool", name: "read_file", secondary: "src/a.ts", dur: "0.1s", bar: { left: 24, w: 3 }, depth: 2, err: true },
          { kind: "tool", name: "read_file", secondary: "src/a.ts", dur: "0.1s", bar: { left: 28, w: 3 }, depth: 2, err: true },
          { kind: "llm", name: "final", secondary: "gpt-4.1 · 残缺结论", dur: "1.5s", bar: { left: 70, w: 28 }, depth: 1 },
        ],
        // Detail: RAS anomaly events + recovery actions
        anomalies: [
          {
            id: "ev_001", ts: "2026-07-30T15:38:13Z",
            anomalyKind: "llm_thinking_dead_loop", severity: "high",
            summary: "语义判定：思考内容在同一论点上反复循环，无推进。",
            actions: [{ type: "abort_stream", message: "检测到思考死循环，已请求中止当前生成。" }],
          },
          {
            id: "ev_002", ts: "2026-07-30T15:38:15Z",
            anomalyKind: "repeat_tool_call", severity: "medium",
            summary: "工具 read_file 连续 4 次相同参数调用。",
            actions: [{ type: "emit_notice", message: "检测到工具重复调用，请改用已有内容继续。" }],
          },
        ],
      },
      {
        taskId: "task_7f2a91bc",
        executionId: "exec_7f2a",
        latestTs: "2026-07-30T15:41:02Z",
        anomalyKind: "llm_thinking_dead_loop",
        severity: "high",
        summary: "语义判定：思考内容在同一论点上反复循环，无推进。",
        eventCount: 1,
        traceStatus: "success",
        traceStatusReason: "",
        detectionLevel: "L1",
        completedAt: "2026-07-30T15:41:05Z",
        framework: "opencode",
        agentName: "research-bot",
        spans: [
          { kind: "task", name: "research-bot", secondary: "整理 RFC 引用", dur: "4.8s", bar: { left: 0, w: 100 }, depth: 0 },
          { kind: "user", name: "user", secondary: "整理 RFC 引用", dur: "—", bar: { left: 0, w: 2 }, depth: 1 },
          { kind: "llm", name: "plan", secondary: "gpt-4.1", dur: "1.2s", bar: { left: 2, w: 24 }, depth: 1, ras: "dead_loop", rasSeverity: "high", rasLabel: "思考死循环" },
          { kind: "tool", name: "web_search", secondary: "agent reliability", dur: "0.8s", bar: { left: 28, w: 16 }, depth: 1 },
          { kind: "tool", name: "read_file", secondary: "docs/rfc.md", dur: "0.1s", bar: { left: 46, w: 4 }, depth: 1 },
          { kind: "llm", name: "final", secondary: "gpt-4.1", dur: "2.1s", bar: { left: 52, w: 44 }, depth: 1 },
        ],
        anomalies: [
          {
            id: "ev_003", ts: "2026-07-30T15:41:03Z",
            anomalyKind: "llm_thinking_dead_loop", severity: "high",
            summary: "LLM 思考死循环：在同一论点上反复循环，无实质性推进。",
            actions: [
              { type: "abort_stream", message: "中止当前 LLM 生成流。" },
              { type: "emit_notice", message: "向交互链路发出 notice 提示。" },
              { type: "push_steering", message: "向 Agent 推送 steering 指令，引导切换思路。" },
            ],
          },
        ],
      },
      {
        taskId: "task_dd991122",
        executionId: "exec_dd99",
        latestTs: "2026-07-30T14:12:55Z",
        anomalyKind: "tool_call_loop",
        severity: "medium",
        summary: "工具 bash 连续返回 exit 1，Agent 反复重试。",
        eventCount: 1,
        traceStatus: "failed",
        traceStatusReason: "ras-interrupted",
        detectionLevel: "L3",
        completedAt: null,
        framework: "opencode",
        agentName: "code-fixer",
        spans: [
          { kind: "task", name: "code-fixer", secondary: "跑测试", dur: "11.0s", bar: { left: 0, w: 100 }, depth: 0 },
          { kind: "user", name: "user", secondary: "跑测试", dur: "—", bar: { left: 0, w: 2 }, depth: 1 },
          { kind: "tool", name: "bash", secondary: "npm test · exit 1", dur: "2.1s", bar: { left: 4, w: 20 }, depth: 1, err: true, ras: "tool_loop", rasSeverity: "medium", rasLabel: "工具调用循环" },
          { kind: "tool", name: "bash", secondary: "npm test · exit 1 (retry 1)", dur: "2.0s", bar: { left: 26, w: 19 }, depth: 1, err: true },
          { kind: "tool", name: "bash", secondary: "npm test · exit 1 (retry 2)", dur: "1.9s", bar: { left: 46, w: 18 }, depth: 1, err: true },
          { kind: "llm", name: "analyze", secondary: "gpt-4.1 · 忽略错误", dur: "2.4s", bar: { left: 66, w: 22 }, depth: 1 },
        ],
        anomalies: [
          {
            id: "ev_004", ts: "2026-07-30T14:12:56Z",
            anomalyKind: "tool_call_loop", severity: "medium",
            summary: "工具 bash 连续返回非零退出码，Agent 陷入调用循环。",
            actions: [
              { type: "surface_stderr", message: "将 bash stderr 输出前置给 LLM，提示关注错误信息。" },
            ],
          },
        ],
      },
      {
        taskId: "task_33aa1190",
        executionId: "exec_33aa",
        latestTs: "2026-07-30T15:20:03Z",
        anomalyKind: "",
        severity: null,
        summary: null,
        eventCount: 0,
        traceStatus: "success",
        traceStatusReason: "",
        detectionLevel: null,
        completedAt: "2026-07-30T15:20:03Z",
        framework: "openclaw",
        agentName: "doc-writer",
        spans: [
          { kind: "task", name: "doc-writer", secondary: "doc-writer · task_33aa1190", dur: "2.1s", bar: { left: 0, w: 100 }, depth: 0 },
          { kind: "user", name: "user", dur: "—", bar: { left: 0, w: 4 }, depth: 1 },
          { kind: "llm", name: "reply", secondary: "gpt-4.1", dur: "1.8s", bar: { left: 10, w: 80 }, depth: 1 },
        ],
        anomalies: [],
      },
      {
        taskId: "task_ab12ff01",
        executionId: "exec_ab12",
        latestTs: "2026-07-30T14:55:41Z",
        anomalyKind: "llm_thinking_dead_loop",
        severity: "high",
        summary: "LLM 思考规划阶段检测到语义循环。",
        eventCount: 1,
        traceStatus: "success",
        traceStatusReason: "",
        detectionLevel: "L1",
        completedAt: "2026-07-30T14:55:42Z",
        framework: "opencode",
        agentName: "research-bot",
        spans: [
          { kind: "task", name: "research-bot", secondary: "research-bot · task_ab12ff01", dur: "3.4s", bar: { left: 0, w: 100 }, depth: 0 },
          { kind: "llm", name: "plan", secondary: "gpt-4.1", dur: "1.0s", bar: { left: 2, w: 28 }, depth: 1, ras: "dead_loop", rasSeverity: "high", rasLabel: "思考死循环" },
          { kind: "tool", name: "web_search", dur: "0.9s", bar: { left: 32, w: 26 }, depth: 1 },
          { kind: "llm", name: "final", secondary: "gpt-4.1", dur: "1.1s", bar: { left: 60, w: 38 }, depth: 1 },
        ],
        anomalies: [
          {
            id: "ev_005", ts: "2026-07-30T14:55:41Z",
            anomalyKind: "llm_thinking_dead_loop", severity: "high",
            summary: "LLM 规划阶段在同一议题上产生循环推理，已请求中止。",
            actions: [
              { type: "abort_stream", message: "中止当前 LLM 生成流。" },
            ],
          },
        ],
      },
    ];

    // ── Anomaly kind & severity labels aligned with normalize.ts ──
    const ANOMALY_KIND_LABEL = {
      llm_thinking_loop: "思考循环",
      llm_thinking_dead_loop: "思考死循环",
      repeat_tool_call: "工具重复调用",
      tool_call_loop: "工具调用循环",
    };
    const SEVERITY_LABEL = {
      low: "低危",
      medium: "中危",
      high: "高危",
      critical: "严重",
    };
    function sevToStatusKind(sev) {
      const s = (sev || "").toLowerCase();
      if (s === "critical" || s === "high") return "error";
      if (s === "medium") return "warning";
      return "pending";
    }
    function sevColor(sev) {
      const s = (sev || "").toLowerCase();
      if (s === "critical" || s === "high") return "var(--error)";
      if (s === "medium") return "var(--warning)";
      if (s === "low") return "var(--foreground-secondary)";
      return "var(--success)";
    }

    // ── Stat cards with actual design ──
    const allTraces = RAS_TRACES;
    const sevCounts = { critical: 1, high: 3, medium: 2, low: 1, none: 1 };
    const stats = [
      { key: "total", label: "Traces", value: allTraces.length, accentClass: "val-count" },
      { key: "critical", label: "严重 (critical)", value: sevCounts.critical, accentClass: "val-error" },
      { key: "high", label: "高危 (high)", value: sevCounts.high, accentClass: "val-error" },
      { key: "medium", label: "中危 (medium)", value: sevCounts.medium, accentClass: "val-warning" },
      { key: "low", label: "低危 (low)", value: sevCounts.low, accentClass: "val-warning" },
      { key: "none", label: "无故障", value: sevCounts.none, accentClass: "val-success" },
    ];

    const statCards = stats
      .map((s) => {
        const clickable = s.key !== "total";
        return `
      <div class="ras-stat-card ${clickable ? "clickable" : ""}${s.key === "high" ? " active" : ""}" data-ras-sev="${esc(s.key)}" ${s.key === "total" ? "" : 'role="button"'}>
        <div class="label">${esc(s.label)}</div>
        <div class="value ${esc(s.accentClass)}">${s.value}</div>
      </div>`;
      })
      .join("");

    // ── Table columns matching actual: Trace ID | 摘要 | 故障类型 | 严重等级 | 执行状态 | 时间 | 事件数 | 操作 ──
    const formatTime = (ts) => {
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      return hh + ":" + mm + ":" + ss;
    };

    const traceStatusLabel = (t) => {
      if (t.traceStatus === "running") return { cls: "warning", label: "执行中" };
      if (t.traceStatus === "failed") {
        return t.traceStatusReason === "ras-interrupted"
          ? { cls: "error", label: "异常中断" }
          : { cls: "error", label: "执行失败" };
      }
      return { cls: "success", label: "正常完成" };
    };

    const rows = allTraces.map((t) => [
      `<button type="button" class="link mono" data-ras-trace-open="${esc(t.taskId)}">${esc(t.taskId.slice(0, 16) + "…")}</button>`,
      `<span style="font-size:12px;max-width:220px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.summary || "—")}</span>`,
      `<span style="font-size:11px;color:var(--foreground-secondary)">
        ${t.anomalyKind ? (ANOMALY_KIND_LABEL[t.anomalyKind] || t.anomalyKind) : "—"}
        ${t.detectionLevel ? `<span style="margin-left:4px;font-family:var(--font-mono);font-size:9px;color:var(--foreground-muted)">${esc(t.detectionLevel)}</span>` : ""}
      </span>`,
      t.severity
        ? status(SEVERITY_LABEL[t.severity.toLowerCase()] || t.severity, sevToStatusKind(t.severity))
        : status("无故障", "success"),
      (() => { const l = traceStatusLabel(t); return status(l.label, l.cls); })(),
      `<span style="font-size:11px;font-family:var(--font-mono);color:var(--foreground-muted)">${formatTime(t.latestTs)}</span>`,
      `<span style="font-size:11px;font-family:var(--font-mono);color:var(--foreground-muted);text-align:center;display:block">${t.eventCount}</span>`,
      btn("查看详情", { variant: "ghost", size: "sm", attrs: `data-ras-trace-open="${esc(t.taskId)}"` }),
    ]);

    // ── Detail views with RAS anomaly events + trace waterfall ──
    const rasTraceSpans = (task) => {
      return (task.spans || [])
        .map(
          (s, i) =>
            `<button type="button" class="span-row ${s.err ? "err" : ""}${s.ras ? " selected" : ""}" data-span="${esc(task.taskId)}-${i}" ${s.ras ? `data-ras-node="${esc(s.ras)}" data-ras-label="${esc(s.rasLabel)}" data-ras-severity="${esc(s.rasSeverity)}"` : ""} style="padding-left:${8 + (s.depth || 0) * 16}px">
        <span class="kind-badge kind-${esc(s.kind)}">${esc(s.kind)}</span>
        <span class="span-name">${esc(s.name)}${s.secondary ? `<span class="span-sec">${esc(s.secondary)}</span>` : ""}</span>
        <span class="gantt"><i style="margin-left:${(s.bar || { left: 0 }).left}%;width:${(s.bar || { w: 100 }).w}%"></i></span>
        <span class="span-dur">${esc(s.dur)}</span>
        ${s.ras ? badge(s.rasLabel, s.rasSeverity === "high" ? "fail" : "warn") : ""}
      </button>`
        )
        .join("");
    };

    const rasAnomalyEvents = (t) => {
      if (!t.anomalies || !t.anomalies.length) {
        return `<div class="empty-box"><p class="empty-title">无 RAS 异常事件</p><p class="empty-desc">该 Trace 暂未检测到 RAS 异常</p></div>`;
      }
      return t.anomalies
        .map((ev) => {
          const actionEls = (ev.actions || [])
            .map((a) => `
            <div style="border:1px solid var(--border);border-radius:6px;background:var(--background-secondary);padding:8px;margin-top:6px">
              <div style="display:flex;align-items:center;gap:6px">
                <span class="badge kind" style="font-family:var(--font-mono);font-size:10px">${esc(a.type)}</span>
                <span style="font-size:11px;font-weight:500;color:var(--foreground-secondary)">处置操作</span>
              </div>
              <pre style="margin:4px 0 0;font-size:11px;color:var(--foreground-secondary);max-height:80px;overflow:auto;white-space:pre-wrap;word-break:break-word">${esc(a.message)}</pre>
            </div>`)
            .join("");
          return `
          <div style="border:1px solid var(--card-border);border-radius:8px;background:var(--card-bg);padding:12px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
              ${ev.anomalyKind ? badge(ANOMALY_KIND_LABEL[ev.anomalyKind] || ev.anomalyKind, "kind") : ""}
              ${ev.severity ? status(SEVERITY_LABEL[ev.severity.toLowerCase()] || ev.severity, sevToStatusKind(ev.severity)) : ""}
              <span style="font-size:11px;color:var(--foreground-muted);margin-left:auto">${formatTime(ev.ts)}</span>
            </div>
            ${ev.summary ? `<p style="font-size:12px;color:var(--foreground-secondary);margin:0">${esc(ev.summary)}</p>` : ""}
            ${actionEls}
          </div>`;
        })
        .join("");
    };

    const details = allTraces.map(
      (t) => `
      <div class="trace-detail" data-ras-trace-detail="${esc(t.taskId)}" hidden>
        <div class="trace-detail-bar">
          <button type="button" class="btn ghost sm" data-ras-trace-back>← 返回列表</button>
          <span class="toolbar-sep"></span>
          <code class="mono" style="font-size:11px">${esc(t.taskId.slice(0, 20) + "…")}</code>
          ${(() => { const l = traceStatusLabel(t); return status(l.label, l.cls); })()}
          ${t.framework ? badge(t.framework, "mod") : ""}
          <span class="metric-pill"><span class="lbl">事件</span><span class="val">${t.eventCount}</span></span>
          <span style="flex:1"></span>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${t.anomalyKind ? btn("智能诊断", { variant: "default", size: "sm", attrs: 'data-goto="fault"' }) : ""}
            ${btn("导出 Trace", { variant: "outline", size: "sm", demo: true })}
          </div>
        </div>

        <h3 style="font-size:12px;font-weight:600;margin:0 0 8px">RAS 可靠性异常事件 <span style="font-weight:400;color:var(--foreground-muted)">${(t.anomalies || []).length}</span></h3>
        ${rasAnomalyEvents(t)}

        <div style="margin:12px 0;border-top:1px solid var(--border)"></div>

        <h3 style="font-size:12px;font-weight:600;margin:0 0 8px">完整链路追踪</h3>
        <div class="trace-split">
          <div class="trace-waterfall">
            <div class="wf-hd">
              <span>Span</span>
              <span style="margin-left:auto">Timeline</span>
              <span style="width:48px;text-align:right">Dur</span>
              <span style="width:80px;text-align:right">RAS</span>
            </div>
            ${rasTraceSpans(t)}
          </div>
          <div class="trace-span-detail" data-span-detail>
            <div class="tabs" data-tabs="ras-span">
              <button type="button" class="tab active" data-tab="overview">概览</button>
              <button type="button" class="tab" data-tab="prompt">上下文</button>
            </div>
            <div class="tab-panels">
              <div class="tab-panel active" data-panel="overview">
                <div class="detail-kv"><span>Task ID</span><strong>${esc(t.taskId)}</strong></div>
                <div class="detail-kv"><span>Agent</span><strong>${esc(t.agentName || "—")}</strong></div>
                <div class="detail-kv"><span>平台/框架</span><strong>${esc(t.framework || "—")}</strong></div>
                <div class="detail-kv"><span>检测等级</span><strong>${esc(t.detectionLevel || "—")}</strong></div>
                <div class="detail-kv"><span>事件数</span><strong>${t.eventCount}</strong></div>
                <div class="detail-kv"><span>执行状态</span><strong>${traceStatusLabel(t).label}</strong></div>
              </div>
              <div class="tab-panel" data-panel="prompt">
                <div class="prompt-msg"><div class="pm-role">RAS 检测上下文</div><pre class="pm-body">Anomaly kind: ${esc(t.anomalyKind || "none")}
Severity: ${esc(t.severity || "none")}
Detection: ${esc(t.detectionLevel || "none")}</pre></div>
                <div class="prompt-msg"><div class="pm-role">交互</div><pre class="pm-body">Task: ${esc(t.taskId)}
Agent: ${esc(t.agentName || "—")}</pre></div>
              </div>
            </div>
          </div>
        </div>
      </div>`
    );

    const body = `
      ${relNote("AgentRAS 可靠性观测：按故障严重程度分类统计，每个 Trace 可点击查看故障节点。")}
      <div class="ras-count-row">
        <span>共 <strong>${allTraces.length}</strong> 次记录</span>
        <button type="button" class="ras-clear-filter hidden" data-ras-clear-filter>清除筛选</button>
      </div>
      <div class="ras-stat-grid">
        ${statCards}
      </div>
      <div class="ras-filter-bar">
        <div class="sk-filter">
          <button type="button" class="on" data-ras-filter="all">全部</button>
          <button type="button" data-ras-filter="high">高危</button>
          <button type="button" data-ras-filter="medium">中危</button>
          <button type="button" data-ras-filter="none">无故障</button>
        </div>
        ${select("平台", "rasPlat", [["all", "全部平台"], ["opencode", "opencode"], ["openclaw", "openclaw"]], "all")}
        ${select("Agent", "rasAg", [["all", "全部 Agent"], ["code-fixer", "code-fixer"], ["research-bot", "research-bot"], ["doc-writer", "doc-writer"]], "all")}
        <span class="toolbar-sep"></span>
        ${select("时间", "rasTime", [["1h", "近 1h"], ["24h", "近 24h"], ["7d", "近 7d"]], "24h")}
        ${btn("重置筛选", { variant: "ghost", size: "sm", demo: true })}
      </div>
      <div id="rasTraceListView">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;flex-wrap:wrap">
          <h2 style="margin:0;font-size:13px;font-weight:600">链路列表 <span style="color:var(--foreground-muted);font-weight:400">${allTraces.length}</span></h2>
        </div>
        <div class="ras-trace-table-wrap">
          ${dataTable(["Trace ID", "摘要", "故障类型", "严重等级", "执行状态", "时间", "事件数", "操作"], rows)}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap;gap:8px">
          <span style="color:var(--foreground-muted)">第 1–${allTraces.length} / ${allTraces.length} · 每页 20</span>
          <div style="display:flex;gap:8px">${btn("上一页", { variant: "outline", size: "sm", demo: true })}${btn("下一页", { variant: "outline", size: "sm", demo: true })}</div>
        </div>
      </div>
      <div id="rasTraceDetailHost">
        ${details}
      </div>`;

    return page("可靠性观测", body, {
      actions: `${btn("导出统计", { variant: "outline", size: "sm", demo: true })}`,
    });
  }
  function agentRasFaultInjection() {
    // ── Fault types matching actual mockData.ts (12 types, 4 categories) ──
    const CATEGORY_LABELS = {
      thinking: "思考类", tool: "工具类", communication: "通信类", resource: "资源类",
    };
    const SEVERITY_DOT_COLORS = {
      critical: "var(--error)", warning: "var(--warning)", info: "var(--foreground-muted)",
    };
    const FAULTS = [
      { id: "thinking_loop", category: "thinking", name: "thinking_loop", label: "思考循环", description: "Agent 陷入无限思考循环，反复生成相似内容但不调用工具", severity: "critical", platforms: ["openjiuwen", "opencode", "hermes", "openclaw"], params: [{ key: "max_iter", label: "最大循环次数", type: "number", defaultValue: "3" }] },
      { id: "repeated_reasoning", category: "thinking", name: "repeated_reasoning", label: "重复推理", description: "Agent 在不同阶段重复相同的推理过程", severity: "warning", platforms: ["openjiuwen", "opencode", "hermes"], params: [{ key: "threshold", label: "重复次数阈值", type: "number", defaultValue: "5" }] },
      { id: "hallucination_drift", category: "thinking", name: "hallucination_drift", label: "幻觉漂移", description: "Agent 生成的内容逐渐偏离事实，产生幻觉输出", severity: "warning", platforms: ["openjiuwen", "opencode", "hermes", "openclaw"], params: [{ key: "drift_ratio", label: "漂移比率", type: "text", defaultValue: "0.3" }] },
      { id: "tool_timeout", category: "tool", name: "tool_timeout", label: "工具超时", description: "Agent 调用工具时超时未返回结果", severity: "critical", platforms: ["openjiuwen", "opencode", "hermes", "openclaw"], params: [{ key: "timeout_ms", label: "超时毫秒数", type: "number", defaultValue: "30000" }] },
      { id: "tool_error", category: "tool", name: "tool_error", label: "工具错误", description: "Agent 调用工具时返回异常错误", severity: "critical", platforms: ["openjiuwen", "opencode", "hermes", "openclaw"], params: [{ key: "error_rate", label: "错误率（0-1）", type: "text", defaultValue: "0.5" }, { key: "error_code", label: "错误码", type: "text", defaultValue: "500" }] },
      { id: "repeated_tool", category: "tool", name: "repeated_tool", label: "工具重复调用", description: "Agent 短时间内重复调用同一工具且参数未发生有效变化", severity: "warning", platforms: ["openjiuwen", "opencode", "hermes", "openclaw"], params: [{ key: "repeat_count", label: "重复次数", type: "number", defaultValue: "3" }] },
      { id: "tool_output_parse_error", category: "tool", name: "tool_output_parse_error", label: "工具输出解析错误", description: "Agent 无法正确解析工具返回的输出格式", severity: "warning", platforms: ["openjiuwen", "opencode", "hermes"], params: [{ key: "parse_rate", label: "解析失败率", type: "text", defaultValue: "0.3" }] },
      { id: "connection_lost", category: "communication", name: "connection_lost", label: "连接丢失", description: "Agent 与外部服务的连接中断", severity: "critical", platforms: ["openjiuwen", "opencode", "hermes", "openclaw"], params: [{ key: "reconnect_attempts", label: "重连尝试次数", type: "number", defaultValue: "3" }] },
      { id: "api_rate_limit", category: "communication", name: "api_rate_limit", label: "API 限流", description: "Agent 调用外部 API 时触发频率限制", severity: "warning", platforms: ["openjiuwen", "opencode", "hermes", "openclaw"], params: [{ key: "retry_after", label: "重试等待秒数", type: "number", defaultValue: "60" }] },
      { id: "auth_expired", category: "communication", name: "auth_expired", label: "认证过期", description: "Agent 的 API 认证令牌过期，无法继续操作", severity: "critical", platforms: ["openjiuwen", "opencode"], params: [] },
      { id: "context_overflow", category: "resource", name: "context_overflow", label: "上下文溢出", description: "Agent 的上下文窗口超出模型限制", severity: "warning", platforms: ["openjiuwen", "opencode", "hermes", "openclaw"], params: [{ key: "max_tokens", label: "最大 tokens", type: "number", defaultValue: "128000" }] },
      { id: "token_exhausted", category: "resource", name: "token_exhausted", label: "Token 耗尽", description: "Agent 运行超出预算的 token 配额", severity: "warning", platforms: ["openjiuwen", "opencode"], params: [{ key: "budget_tokens", label: "Token 预算", type: "number", defaultValue: "100000" }] },
    ];

    // ── Platforms matching actual PlatformSelector ──
    const PLATFORMS = [
      { key: "openjiuwen", label: "openjiuwen", mode: "full" },
      { key: "opencode", label: "OpenCode", mode: "thin" },
      { key: "hermes", label: "Hermes", mode: "skeleton" },
      { key: "openclaw", label: "OpenClaw", mode: "skeleton" },
    ];

    // ── Mock injection history matching actual mockData.ts ──
    const FAULT_HISTORY = [
      { id: "inj-001", faultType: "thinking_loop", platform: "openjiuwen", target: "deep-agent-v3", status: "completed", createdAt: new Date(Date.now() - 3600000).toISOString(), params: { max_iter: "5" } },
      { id: "inj-002", faultType: "tool_timeout", platform: "opencode", target: "code-review-bot", status: "completed", createdAt: new Date(Date.now() - 7200000).toISOString(), params: { timeout_ms: "15000" } },
      { id: "inj-003", faultType: "connection_lost", platform: "openjiuwen", target: "deep-agent-v3", status: "failed", createdAt: new Date(Date.now() - 10800000).toISOString(), params: { reconnect_attempts: "3" } },
      { id: "inj-004", faultType: "tool_error", platform: "hermes", target: "hermes-agent-01", status: "completed", createdAt: new Date(Date.now() - 14400000).toISOString(), params: { error_rate: "0.3", error_code: "503" } },
    ];

    const STATUS_CONFIG = {
      pending: { label: "等待中", cls: "pending" },
      running: { label: "运行中", cls: "running" },
      completed: { label: "已完成", cls: "completed" },
      failed: { label: "失败", cls: "failed" },
    };

    // ── Platform Selector ──
    const platformBtns = PLATFORMS
      .map((p) => {
        const isActive = p.key === "openjiuwen";
        return `
        <button type="button" class="platform-sel-btn${isActive ? " active" : ""}" data-platform="${esc(p.key)}">
          <span>${esc(p.label)}</span>
          ${p.mode !== "full" ? `<span class="platform-mode-tag mode-${p.mode}">${p.mode === "thin" ? "薄插件" : "骨架"}</span>` : ""}
        </button>`;
      })
      .join("");

    // ── Fault Catalog with category groups ──
    const grouped = {};
    FAULTS.forEach((f) => {
      if (!grouped[f.category]) grouped[f.category] = [];
      grouped[f.category].push(f);
    });

    const catGroups = Object.entries(grouped)
      .map(([cat, items]) => {
        const catLabel = CATEGORY_LABELS[cat] || cat;
        const itemsHtml = items
          .map((f) => {
            const sevDot = SEVERITY_DOT_COLORS[f.severity] || "var(--foreground-muted)";
            return `
            <button type="button" class="fault-cat-item" data-fault-id="${esc(f.id)}" title="${esc(f.description)}">
              <span class="sev-dot" style="background:${sevDot}"></span>
              <div style="min-width:0;flex:1">
                <div class="item-name">${esc(f.label)}</div>
                <div class="item-desc">${esc(f.description)}</div>
              </div>
            </button>`;
          })
          .join("");
        return `
          <div data-fault-cat="${esc(cat)}">
            <button type="button" class="fault-cat-group-btn" data-fault-cat-toggle="${esc(cat)}">
              <span class="cat-chev">▸</span>
              <span>${esc(catLabel)}</span>
              <span class="fault-cat-count">${items.length}</span>
            </button>
            <div data-fault-cat-panel="${esc(cat)}">${itemsHtml}</div>
          </div>`;
      })
      .join("");

    const faultCatalog = `
      <div class="fault-catalog" id="faultCatalog">
        <div class="fault-catalog-hd">故障类型目录</div>
        ${catGroups}
      </div>`;

    // ── Injection Config ──
    const injectionConfig = `
      <div class="inj-config-section">
        <h4>注入配置</h4>
        <div class="inj-field-group">
          <label>注入模式</label>
          <div class="inj-mode-toggle">
            <button type="button" class="inj-mode-btn active-mode" data-inj-mode="single">单条注入</button>
            <button type="button" class="inj-mode-btn" data-inj-mode="batch">批量注入</button>
          </div>
        </div>
        <div class="inj-field-group">
          <label>已选故障</label>
          <div class="inj-selected-fault-empty" id="injSelectedFault">请从左侧目录选择故障类型</div>
        </div>
        <div class="inj-field-group">
          <label>目标 Agent ID</label>
          <input class="input" id="injTargetAgent" placeholder="如: deep-agent-v3" style="width:100%" />
        </div>
        <div class="inj-field-group">
          <label>注入参数</label>
          <div id="injParams" style="display:flex;flex-direction:column;gap:8px;color:var(--foreground-muted);font-size:11px">选择故障类型后可配置参数</div>
        </div>
        <button type="button" class="btn primary" id="btnInject" style="width:100%">注入故障</button>
      </div>`;

    // ── Injection History grid ──
    const formatTime = (ts) => {
      const d = new Date(ts);
      return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    const historyRows = FAULT_HISTORY
      .map((h) => {
        const st = STATUS_CONFIG[h.status] || STATUS_CONFIG.pending;
        const faultLabel = (FAULTS.find((f) => f.id === h.faultType) || { label: h.faultType }).label;
        const paramsStr = Object.entries(h.params).map(([k, v]) => `${k}=${v}`).join(", ") || "—";
        return `
        <div class="inj-history-row">
          <span style="font-family:var(--font-mono);font-size:10px;color:var(--foreground-muted)">${esc(h.id.slice(-8))}</span>
          <span style="font-size:11px;color:var(--foreground-secondary)">${esc(faultLabel)}</span>
          <span style="font-size:11px;color:var(--foreground-muted)">${esc(h.platform)}</span>
          <span style="font-size:11px;color:var(--foreground-muted)">${esc(h.target)}</span>
          <span class="inj-status-tag ${st.cls}">${esc(st.label)}</span>
          <span style="font-size:10px;color:var(--foreground-muted)">${formatTime(h.createdAt)}</span>
        </div>`;
      })
      .join("");

    const injectionHistory = `
      <div class="inj-history-grid">
        <div class="inj-history-grid-hd">注入历史 <span style="font-weight:400;margin-left:8px">(${FAULT_HISTORY.length})</span></div>
        <div class="inj-history-row-hd">
          <span>ID</span><span>故障类型</span><span>平台</span><span>目标</span><span>状态</span><span>参数</span>
        </div>
        ${historyRows}
      </div>`;

    const body = `
      ${relNote("故障注入与评测：支持按故障类型单个/批量注入，跨平台运行。")}
      <div class="mock-banner">
        模拟模式：本页只生成前端演示记录，不会向 Agent 下发真实故障，也不会改变运行中的会话。
      </div>
      <div class="inj-field-group" style="margin-bottom:16px">
        <label style="display:block;font-size:11px;font-weight:600;color:var(--foreground-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">选择平台</label>
        <div class="platform-sel" id="platformSel">
          ${platformBtns}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:280px 1fr;gap:16px;margin-top:16px">
        ${faultCatalog}
        <div>
          ${injectionConfig}
        </div>
      </div>
      <div style="margin-top:24px">
        ${injectionHistory}
      </div>`;

    return page("故障注入与评测（Mock）", body, {
      actions: `${btn("查看评测报告", { variant: "outline", size: "sm", demo: true })}`,
    });
  }

  const map = {
    dashboard,
    agents,
    trace,
    "version-analysis": versionAnalysis,
    fault,
    quality,
    infra,
    dataset,
    metrics,
    eval: evalPage,
    skills,
    "skill-generator": skillGenerator,
    "skill-eval": skillEval,
    "skill-opt": skillOpt,
    "model-registry": modelRegistry,
    "web-search": webSearch,
    "version-management": versionManagement,
    "access-install": accessInstall,
    "agent-ras-trace": agentRasTrace,
    "agent-ras-fault-injection": agentRasFaultInjection,
  };

  return {
    render(route) {
      const fn = map[route];
      return fn ? fn() : page("未知", "<p>未知路由</p>");
    },
  };
})();
