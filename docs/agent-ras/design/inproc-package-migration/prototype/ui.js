/** Shared UI kit — aligned to Insight Button / Select / cards */
window.UI = (() => {
  let showRel = localStorage.getItem("protoShowRel") === "1";

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setShowRel(v) {
    showRel = !!v;
    localStorage.setItem("protoShowRel", showRel ? "1" : "0");
    document.body.classList.toggle("show-rel", showRel);
  }

  function getShowRel() {
    return showRel;
  }

  function topbar({ title, actions = "" }) {
    return `
      <header class="topbar">
        <button type="button" class="topbar-toggle" id="btnSidebar" title="折叠侧栏" aria-label="折叠侧栏">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
        </button>
        <div class="topbar-title">${title}</div>
        <div class="topbar-actions">${actions}</div>
      </header>`;
  }

  function page(title, body, opts = {}) {
    return `
      <div class="page-frame">
        ${topbar({ title, actions: opts.actions || "" })}
        <div class="page-body ${opts.bodyClass || ""}">${body}</div>
      </div>`;
  }

  /** Insight-style Select chip (label + value + chevron) */
  function select(label, id, options, value = "all") {
    const cur = options.find((o) => o[0] === value) || options[0];
    const active = value !== "all" && value !== "" && value !== options[0]?.[0];
    const optsJson = esc(JSON.stringify(options));
    return `
      <button type="button" class="chip-select ${active ? "active" : ""}" id="${esc(id)}"
        data-chip-select data-value="${esc(cur[0])}" data-options='${optsJson}' data-label="${esc(label)}">
        <span class="chip-lbl">${esc(label)}</span>
        <span class="chip-val">${esc(cur[1])}</span>
        <svg class="chip-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>`;
  }

  function btn(label, opts = {}) {
    const v = opts.variant || "outline";
    const sz = opts.size || "sm";
    const extra = opts.attrs || "";
    const demo = opts.demo ? " data-demo" : "";
    return `<button type="button" class="btn ${v} ${sz}"${demo} ${extra}>${label}</button>`;
  }

  function toast(msg) {
    let el = document.getElementById("protoToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "protoToast";
      el.className = "proto-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  function relNote(text) {
    return `<div class="rel-note" data-rel>${esc(text)}</div>`;
  }

  function badge(text, cls = "") {
    return `<span class="badge ${cls}">${esc(text)}</span>`;
  }

  function status(text, kind = "muted") {
    return `<span class="status-badge ${kind}">${esc(text)}</span>`;
  }

  function dataTable(headers, rows, opts = {}) {
    const th = headers.map((h) => `<th>${typeof h === "string" ? esc(h) : h}</th>`).join("");
    const tr = rows
      .map((r, i) => {
        const sel = opts.selected === i ? " selected" : "";
        return `<tr class="${sel}" data-row="${i}">${r.map((c) => `<td>${c}</td>`).join("")}</tr>`;
      })
      .join("");
    return `<div class="table-wrap"><table class="data"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }

  /** Horizontal bar rank chart */
  function hbar(items, color = "var(--primary)") {
    const max = Math.max(...items.map((i) => i.value), 1);
    return `<div class="hbar-list">${items
      .map(
        (it) => `
      <div class="hbar-row">
        <div class="hbar-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${Math.round((it.value / max) * 100)}%;background:${color}"></div></div>
        <div class="hbar-val">${esc(it.label ?? String(it.value))}</div>
      </div>`
      )
      .join("")}</div>`;
  }

  /** Vertical histogram */
  function hist(items, opts = {}) {
    const max = Math.max(...items.map((i) => i.n), 1);
    const h = opts.height || 160;
    return `<div class="hist" style="height:${h}px">${items
      .map(
        (it) => `
      <div class="hist-col">
        <div class="hist-bar ${it.accent || ""}" style="height:${Math.round((it.n / max) * 100)}%"></div>
        <div class="hist-lbl">${esc(it.label)}</div>
      </div>`
      )
      .join("")}</div>`;
  }

  function fleetKpi(cards) {
    return `<div class="fleet-kpi">${cards
      .map(
        (c) => `
      <div class="fleet-kpi-card">
        <div class="fk-label"><span class="fk-group">${esc(c.group)}</span>${esc(c.label)}</div>
        <div class="fk-value tone-${c.tone || "count"}">${esc(c.value)}</div>
        <div class="fk-delta ${c.deltaDir || ""}">${esc(c.delta || "环比 —")}</div>
      </div>`
      )
      .join("")}</div>`;
  }

  function panel(title, body, hint = "") {
    return `<div class="panel dash-panel">
      <div class="panel-hd"><span>${esc(title)}</span>${hint ? `<span class="panel-hint">${esc(hint)}</span>` : ""}</div>
      <div class="panel-bd">${body}</div>
    </div>`;
  }

  function empty(title, desc) {
    return `<div class="empty-box"><p class="empty-title">${esc(title)}</p><p class="empty-desc">${esc(desc)}</p></div>`;
  }

  return {
    esc,
    topbar,
    page,
    select,
    btn,
    badge,
    status,
    relNote,
    toast,
    dataTable,
    hbar,
    hist,
    fleetKpi,
    panel,
    empty,
    setShowRel,
    getShowRel,
  };
})();
