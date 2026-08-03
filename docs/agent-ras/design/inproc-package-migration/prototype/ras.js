/** /ras interactive page — mock EventBus */
window.RasPage = (() => {
  const KIND_LABEL = {
    llm_thinking_loop: "思考循环",
    llm_thinking_dead_loop: "思考死循环",
    repeat_tool_call: "工具重复调用",
    tool_call_loop: "工具调用循环",
  };
  const ACTION_LABEL = {
    abort_stream: "中止生成",
    emit_notice: "用户提示",
    push_steering: "纠偏续作",
  };

  const SESSIONS = [
    {
      id: "opencode:ses_7f2a",
      platform: "opencode",
      lastKind: "llm_thinking_dead_loop",
      lastSeverity: "high",
      summary: "语义判定：思考内容在同一论点上反复循环，无推进。",
      events: [
        { type: "session_hello", ts: "15:41:02", payload: { platform: "opencode" } },
        { type: "observe", ts: "15:41:08", payload: { channel: "llm_reasoning", text_chars: 4200 } },
        { type: "observe", ts: "15:41:19", payload: { channel: "llm_reasoning", text_chars: 12800 } },
        {
          type: "skill_requests",
          ts: "15:41:20",
          payload: { skill_name: "llm-loop-detection", role: "detection", request_id: "req_a1" },
        },
        { type: "skill_result", ts: "15:41:24", payload: { request_id: "req_a1", ok: true, verdict: "abnormal" } },
        {
          type: "anomaly",
          ts: "15:41:24",
          payload: {
            kind: "llm_thinking_dead_loop",
            severity: "high",
            summary: "语义判定：思考内容在同一论点上反复循环，无推进。",
            evidence: { mode: "semantic", window_chars: 2000, repeat_hint: 5 },
          },
        },
        {
          type: "actions",
          ts: "15:41:24",
          payload: {
            actions: [
              { type: "abort_stream" },
              {
                type: "emit_notice",
                message: "检测到思考死循环，已请求中止当前生成。请调整任务目标后重试。",
              },
              {
                type: "push_steering",
                message:
                  "<system-reminder>\n先前回复陷入重复推理。请直接给出可执行的下一步，避免复述同一段分析。\n</system-reminder>",
              },
            ],
          },
        },
        {
          type: "action_result",
          ts: "15:41:25",
          payload: { action: "abort_stream", ok: true, channel: "session.abort" },
        },
        {
          type: "action_result",
          ts: "15:41:25",
          payload: { action: "emit_notice", ok: true, channel: "tui.toast" },
        },
      ],
    },
    {
      id: "opencode:ses_91bc",
      platform: "opencode",
      lastKind: "repeat_tool_call",
      lastSeverity: "medium",
      summary: "工具 read_file 连续重复调用，参数相同。",
      events: [
        { type: "observe", ts: "15:38:11", payload: { kind: "tool", tool: "read_file", text_chars: 0 } },
        {
          type: "anomaly",
          ts: "15:38:40",
          payload: {
            kind: "repeat_tool_call",
            severity: "medium",
            summary: "工具 read_file 连续重复调用，参数相同。",
            evidence: { tool: "read_file", streak: 4 },
          },
        },
        {
          type: "actions",
          ts: "15:38:40",
          payload: {
            actions: [
              {
                type: "emit_notice",
                message: "检测到工具重复调用（read_file）。请改用已读结果继续。",
              },
              {
                type: "push_steering",
                message: "停止重复调用同一工具；基于已有输出推进任务。",
              },
            ],
          },
        },
        {
          type: "action_result",
          ts: "15:38:41",
          payload: { action: "emit_notice", ok: true, channel: "tui.toast" },
        },
      ],
    },
    {
      id: "openjiuwen:run_33",
      platform: "openjiuwen",
      lastKind: "llm_thinking_loop",
      lastSeverity: "low",
      summary: "后缀循环启发式命中（低严重度）。",
      events: [
        {
          type: "anomaly",
          ts: "15:20:03",
          payload: {
            kind: "llm_thinking_loop",
            severity: "low",
            summary: "后缀循环启发式命中（低严重度）。",
            evidence: { mode: "suffix_cycle" },
          },
        },
        {
          type: "actions",
          ts: "15:20:03",
          payload: { actions: [{ type: "push_steering", message: "请缩短思考，给出明确结论。" }] },
        },
      ],
    },
  ];

  let live = true;
  let activeSessionId = SESSIONS[0].id;
  let selectedAnomalyKey = null;

  function kindLabel(k) {
    return KIND_LABEL[k] || k || "未知";
  }

  function sevClass(s) {
    return `badge sev-${s || "low"}`;
  }

  function html() {
    const { topbar, select } = UI;
    return `
      <div class="page-frame" id="rasPage">
        ${topbar({
          title: `环内可靠性 <span class="rel-chip">NEW · 独立于 Trace</span>`,
          actions: `
            <span class="status-badge success" id="svcBadge">同进程运行时已启用</span>
            <button type="button" class="btn ghost sm" id="btnToggleLive">模拟离线</button>
            <button type="button" class="btn outline sm" data-goto="fault">对照：智能诊断</button>
            <button type="button" class="btn outline sm" data-goto="trace">对照：链路追踪</button>
          `,
        })}
        <div class="ras-filters">
          ${select("故障类型", "filterKind", [
            ["all", "全部"],
            ["llm_thinking_loop", "思考循环"],
            ["llm_thinking_dead_loop", "思考死循环"],
            ["repeat_tool_call", "工具重复调用"],
            ["tool_call_loop", "工具调用循环"],
          ])}
          ${select("严重度", "filterSeverity", [
            ["all", "全部"],
            ["low", "low"],
            ["medium", "medium"],
            ["high", "high"],
            ["critical", "critical"],
          ])}
          ${select("平台", "filterPlatform", [
            ["all", "全部"],
            ["opencode", "opencode"],
            ["openjiuwen", "openjiuwen"],
          ])}
          <div class="meta" id="filterMeta">共 — 条事件</div>
        </div>
        <div class="ras-workspace">
          <section class="panel">
            <div class="panel-title">Sessions</div>
            <ul class="session-list" id="sessionList"></ul>
          </section>
          <section class="panel">
            <div class="panel-title">事件时间线 · <span id="activeSessionLabel">—</span></div>
            <ul class="event-list" id="eventList"></ul>
            <div class="empty hidden" id="emptyState">
              <p class="empty-title">无匹配事件</p>
              <p class="empty-desc">调整筛选或切换 Session</p>
            </div>
          </section>
          <section class="panel">
            <div class="panel-title">异常详情</div>
            <div class="empty" id="detailEmpty">
              <p class="empty-title">选择一条 anomaly</p>
              <p class="empty-desc">查看 kind / evidence / actions 原文</p>
            </div>
            <div class="detail-body hidden" id="detailBody"></div>
          </section>
        </div>
      </div>`;
  }

  function els() {
    return {
      sessionList: document.getElementById("sessionList"),
      eventList: document.getElementById("eventList"),
      emptyState: document.getElementById("emptyState"),
      activeSessionLabel: document.getElementById("activeSessionLabel"),
      filterKind: document.getElementById("filterKind"),
      filterSeverity: document.getElementById("filterSeverity"),
      filterPlatform: document.getElementById("filterPlatform"),
      filterMeta: document.getElementById("filterMeta"),
      detailEmpty: document.getElementById("detailEmpty"),
      detailBody: document.getElementById("detailBody"),
      svcBadge: document.getElementById("svcBadge"),
      btnToggleLive: document.getElementById("btnToggleLive"),
    };
  }

  function filters(el) {
    const val = (id) => {
      const node = document.getElementById(id);
      if (!node) return "all";
      if (node.hasAttribute("data-chip-select")) return node.getAttribute("data-value") || "all";
      return node.value || "all";
    };
    return {
      kind: val("filterKind"),
      severity: val("filterSeverity"),
      platform: val("filterPlatform"),
    };
  }

  function sessionPasses(s, f) {
    if (f.platform !== "all" && s.platform !== f.platform) return false;
    if (f.kind !== "all" && s.lastKind !== f.kind) return false;
    if (f.severity !== "all" && s.lastSeverity !== f.severity) return false;
    return true;
  }

  function eventPasses(ev, f) {
    if (ev.type !== "anomaly") return true;
    const p = ev.payload || {};
    if (f.kind !== "all" && p.kind !== f.kind) return false;
    if (f.severity !== "all" && p.severity !== f.severity) return false;
    return true;
  }

  function filteredShow(session, f) {
    const events = session.events.filter((ev) => eventPasses(ev, f));
    if (f.kind !== "all" || f.severity !== "all") {
      return events.filter((ev) =>
        ["anomaly", "actions", "action_result", "skill_requests", "skill_result"].includes(ev.type)
      );
    }
    return events;
  }

  function renderEvent(ev, idx, sid) {
    const { esc } = UI;
    const key = `${sid}|${idx}`;
    if (ev.type === "observe") {
      const p = ev.payload || {};
      return `<li class="event-item observe"><span>${ev.ts}</span> · observe ${p.channel || p.kind || ""} · ${p.text_chars ?? 0} chars</li>`;
    }
    if (ev.type === "session_hello") {
      return `<li class="event-item observe"><span>${ev.ts}</span> · session hello</li>`;
    }
    if (ev.type === "skill_requests") {
      const p = ev.payload || {};
      return `<li class="event-item"><div class="event-head"><span class="badge">skill_requests</span><span class="badge">${esc(p.skill_name || "")}</span><span class="event-time">${ev.ts}</span></div>
        <p class="event-summary">role=${esc(p.role || "")} · ${esc(p.request_id || "")}</p></li>`;
    }
    if (ev.type === "skill_result") {
      const p = ev.payload || {};
      return `<li class="event-item"><div class="event-head"><span class="badge">skill_result</span><span class="status-badge ${p.ok ? "success" : "error"}">${p.ok ? "ok" : "fail"}</span><span class="event-time">${ev.ts}</span></div>
        <p class="event-summary">${esc(p.verdict || "")}</p></li>`;
    }
    if (ev.type === "anomaly") {
      const p = ev.payload || {};
      return `<li class="event-item anomaly"><div class="event-head"><span class="badge kind">${kindLabel(p.kind)}</span><span class="${sevClass(p.severity)}">${p.severity}</span><span class="event-time">${ev.ts}</span></div>
        <p class="event-summary">${esc(p.summary || "")}</p>
        <button type="button" class="btn sm pick" data-anomaly="${key}" style="margin-top:8px">查看详情</button></li>`;
    }
    if (ev.type === "actions") {
      const actions = (ev.payload && ev.payload.actions) || [];
      const chips = actions
        .map((a) => `<span class="badge action">${ACTION_LABEL[a.type] || a.type}</span>`)
        .join("");
      const msgs = actions
        .filter((a) => a.message)
        .map(
          (a) =>
            `<details class="fold"><summary>${ACTION_LABEL[a.type] || a.type} message</summary><pre class="msg">${esc(a.message)}</pre></details>`
        )
        .join("");
      return `<li class="event-item"><div class="event-head"><span class="badge">actions</span><span class="event-time">${ev.ts}</span></div><div class="event-actions">${chips}</div>${msgs}</li>`;
    }
    if (ev.type === "action_result") {
      const p = ev.payload || {};
      return `<li class="event-item"><div class="event-head"><span class="badge">action_result</span><span class="status-badge ${p.ok ? "success" : "error"}">${p.ok ? "ok" : "fail"}</span><span class="badge action">${ACTION_LABEL[p.action] || p.action}</span><span class="event-time">${ev.ts}</span></div>
        <p class="event-summary">channel: <code>${esc(p.channel || "")}</code></p></li>`;
    }
    return `<li class="event-item observe">${ev.type}</li>`;
  }

  function renderDetail(el) {
    const { esc } = UI;
    if (!selectedAnomalyKey) {
      el.detailEmpty.classList.remove("hidden");
      el.detailBody.classList.add("hidden");
      el.detailBody.innerHTML = "";
      return;
    }
    const [sid, idxStr] = selectedAnomalyKey.split("|");
    const session = SESSIONS.find((s) => s.id === sid);
    let ev = null;
    let eventIndex = Number(idxStr);
    if (session && Number.isFinite(eventIndex)) {
      const show = filteredShow(session, filters(el));
      ev = show[eventIndex];
      eventIndex = session.events.indexOf(ev);
    }
    if (!ev || ev.type !== "anomaly") {
      selectedAnomalyKey = null;
      renderDetail(el);
      return;
    }
    const p = ev.payload || {};
    const relatedActions = session.events.find((e, i) => i > eventIndex && e.type === "actions");
    el.detailEmpty.classList.add("hidden");
    el.detailBody.classList.remove("hidden");
    el.detailBody.innerHTML = `
      <div class="detail-row"><div class="detail-label">故障类型</div>
        <span class="badge kind">${kindLabel(p.kind)}</span>
        <code style="margin-left:8px;font-size:11px;color:var(--foreground-muted)">${esc(p.kind)}</code></div>
      <div class="detail-row"><div class="detail-label">严重度</div><span class="${sevClass(p.severity)}">${p.severity}</span></div>
      <div class="detail-row"><div class="detail-label">Summary</div><div>${esc(p.summary || "")}</div></div>
      <div class="detail-row"><div class="detail-label">Evidence</div><pre class="msg">${esc(JSON.stringify(p.evidence || {}, null, 2))}</pre></div>
      <div class="detail-row"><div class="detail-label">Actions（只读原文）</div>
        ${
          relatedActions
            ? relatedActions.payload.actions
                .map((a) => {
                  const body = a.message
                    ? `<pre class="msg">${esc(a.message)}</pre>`
                    : `<p class="event-summary">（无 message）</p>`;
                  return `<div style="margin-bottom:8px"><span class="badge action">${ACTION_LABEL[a.type] || a.type}</span>${body}</div>`;
                })
                .join("")
            : "<p class='empty-desc'>无关联 actions</p>"
        }
      </div>
      <button type="button" class="detail-link" data-goto="trace">在 Trace 中查找同 session →（弱链示意）</button>`;
  }

  function refresh() {
    const el = els();
    if (!el.sessionList) return;
    const { esc } = UI;
    const f = filters(el);
    const list = SESSIONS.filter((s) => sessionPasses(s, f));
    if (!list.find((s) => s.id === activeSessionId) && list[0]) {
      activeSessionId = list[0].id;
      selectedAnomalyKey = null;
    }
    el.sessionList.innerHTML = list
      .map((s) => {
        const active = s.id === activeSessionId ? "active" : "";
        return `<li><button type="button" class="session-item ${active}" data-sid="${s.id}">
          <div class="session-id">${esc(s.id)}</div>
          <div class="session-meta"><span class="badge kind">${kindLabel(s.lastKind)}</span><span class="${sevClass(s.lastSeverity)}">${s.lastSeverity}</span></div>
          <div class="session-summary">${esc(s.summary)}</div>
        </button></li>`;
      })
      .join("");

    const session = SESSIONS.find((s) => s.id === activeSessionId);
    el.activeSessionLabel.textContent = session ? session.id : "—";
    if (!session) {
      el.eventList.innerHTML = "";
      el.emptyState.classList.remove("hidden");
      el.filterMeta.textContent = "共 0 条事件";
      renderDetail(el);
      return;
    }
    const show = filteredShow(session, f);
    el.filterMeta.textContent = `共 ${show.length} 条事件 · ${live ? "实时" : "仅历史"}`;
    if (!show.length) {
      el.eventList.innerHTML = "";
      el.emptyState.classList.remove("hidden");
    } else {
      el.emptyState.classList.add("hidden");
      el.eventList.innerHTML = show.map((ev, idx) => renderEvent(ev, idx, session.id)).join("");
    }
    renderDetail(el);
  }

  function setLive(on) {
    live = on;
    const el = els();
    if (!el.svcBadge) return;
    if (live) {
      el.svcBadge.className = "status-badge success";
      el.svcBadge.textContent = "同进程运行时已启用";
      el.btnToggleLive.textContent = "模拟离线";
    } else {
      el.svcBadge.className = "status-badge warning";
      el.svcBadge.textContent = "服务未运行 · 仅历史";
      el.btnToggleLive.textContent = "模拟上线";
    }
    refresh();
  }

  function bind() {
    const el = els();
    if (!el.sessionList) return;
    el.sessionList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sid]");
      if (!btn) return;
      activeSessionId = btn.getAttribute("data-sid");
      selectedAnomalyKey = null;
      refresh();
    });
    el.eventList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-anomaly]");
      if (!btn) return;
      selectedAnomalyKey = btn.getAttribute("data-anomaly");
      renderDetail(el);
    });
    ["filterKind", "filterSeverity", "filterPlatform"].forEach((id) => {
      const node = el[id];
      if (!node) return;
      node.addEventListener("chipchange", () => {
        selectedAnomalyKey = null;
        refresh();
      });
    });
    el.btnToggleLive.addEventListener("click", () => setLive(!live));
    setLive(live);
  }

  return { html, bind };
})();
