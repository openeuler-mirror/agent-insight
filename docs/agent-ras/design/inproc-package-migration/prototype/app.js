/**
 * Shell + router — mirrors AppSidebar IA
 */
(function () {
  const ICO = {
    dash: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="1"/><rect x="8" y="8" width="4.5" height="4.5" rx="1"/></svg>',
    agent: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="5" r="2.5"/><path d="M2.5 12c1.2-2.2 2.8-3.2 4.5-3.2S10.3 9.8 11.5 12"/></svg>',
    observe: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="2"/><path d="M1.5 7S3.5 3 7 3s5.5 4 5.5 4-2 4-5.5 4S1.5 7 1.5 7z"/></svg>',
    trace: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 3.5h10M2 7h7M2 10.5h5"/><circle cx="11" cy="7" r="1.2"/><circle cx="9" cy="10.5" r="1.2"/></svg>',
    version: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 2.5v9M3 4h5.5l2 1.5-2 1.5H3"/></svg>',
    fault: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 2l5 9H2L7 2z"/><path d="M7 6v2.5M7 10.2h.01"/></svg>',
    ras: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 1.5L2 4v4.5c0 3 2.5 4.5 5 5 2.5-.5 5-2 5-5V4L7 1.5z"/></svg>',
    quality: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 9.5l2.5-2.5 2.5 2.5 5-6"/></svg>',
    infra: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5h10M2 9.5h10"/><circle cx="4.5" cy="4.5" r="1.3"/><circle cx="9.5" cy="9.5" r="1.3"/></svg>',
    eval: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 2.5h8v9H3z"/><path d="M5 5h4M5 7.5h4M5 10h2"/></svg>',
    dataset: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="7" cy="4" rx="4.5" ry="2"/><path d="M2.5 4v2.5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4"/><path d="M2.5 6.5V9c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V6.5"/></svg>',
    metrics: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 11V7.5M5.5 11V4M9 11V6M12 11V3"/></svg>',
    skills: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 1.5l1.5 3.2 3.5.4-2.6 2.4.7 3.5L7 9.2 3.9 11l.7-3.5L2 5.1l3.5-.4L7 1.5z"/></svg>',
    gen: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2.5h6v9H4z"/><path d="M6 5.5h2M7 4.5v2"/></svg>',
    model: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5h10M2 9.5h10"/><circle cx="4.5" cy="4.5" r="1.3"/><circle cx="9.5" cy="9.5" r="1.3"/></svg>',
    web: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="5"/><path d="M2 7h10M7 2a8 8 0 010 10M7 2a8 8 0 000 10"/></svg>',
    tags: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 7.5V2.5H7.5l4 4-5 5-4-4z"/><circle cx="5" cy="5" r="1"/></svg>',
    install: '<svg class="ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 1.5v7M4 6l3 3 3-3"/><path d="M2 11h10"/></svg>',
  };

  function link(route, label, ico, extra = "") {
    return `<button type="button" class="nav-link" data-route="${route}">${ico}<span>${label}</span>${extra}</button>`;
  }

  function child(route, label, ico, extra = "") {
    return `<button type="button" class="nav-link child" data-route="${route}">${ico}<span>${label}</span>${extra}</button>`;
  }

  function tree(key, label, ico, childrenHtml, open = true) {
    return `
      <button type="button" class="nav-tree-toggle ${open ? "open" : ""}" data-tree="${key}">
        <span class="left">${ico}<span>${label}</span></span>
        <span class="chev">${open ? "▾" : "▸"}</span>
      </button>
      <div class="nav-children ${open ? "open" : ""}" data-tree-panel="${key}">${childrenHtml}</div>`;
  }

  function renderNav() {
    document.getElementById("sidebarNav").innerHTML = `
      <div class="nav-card agent">
        <button type="button" class="nav-group-head" data-group="agent">
          <span>Agent Workspace</span><span class="chev">▾</span>
        </button>
        <div class="nav-items" data-group-panel="agent">
          ${link("dashboard", "仪表盘", ICO.dash)}
          ${link("agents", "Agent 管理", ICO.agent)}
          ${tree(
            "observe",
            "运行观测",
            ICO.observe,
            [
              child("trace", "链路追踪", ICO.trace),
              child("version-analysis", "版本分析", ICO.version),
              child("fault", "智能诊断", ICO.fault),
              child("quality", "可靠性与性能", ICO.quality),
              child("infra", "推理 Infra", ICO.infra),
            ].join("")
          )}
          ${tree(
            "agent-ras",
            "AgentRAS 可靠性",
            ICO.ras,
            [
              child("agent-ras-trace", "可靠性观测", ICO.trace),
              child("agent-ras-fault-injection", "故障注入与评测", ICO.fault),
            ].join("")
          )}
          ${tree(
            "eval",
            "评测中心",
            ICO.eval,
            [
              child("dataset", "评测数据集", ICO.dataset),
              child("metrics", "评估器", ICO.metrics),
              child("eval", "评测执行", ICO.eval),
            ].join("")
          )}
          ${tree(
            "skills",
            "Skills 能力",
            ICO.skills,
            [
              child("skills", "Skills Hub", ICO.skills),
              child("skill-generator", "Skills 生成", ICO.gen),
              child("skill-eval", "Skills 评测", ICO.eval),
              child("skill-opt", "Skills 优化", ICO.skills),
            ].join("")
          )}
        </div>
      </div>
      <div class="nav-card">
        <button type="button" class="nav-group-head" data-group="config">
          <span>配置</span><span class="chev">▾</span>
        </button>
        <div class="nav-items" data-group-panel="config">
          ${link("model-registry", "模型注册", ICO.model)}
          ${link("web-search", "联网搜索", ICO.web)}
          ${link("version-management", "版本管理", ICO.tags)}
          ${link("access-install", "安装指导", ICO.install)}
        </div>
      </div>`;
  }

  const TITLES = {
    dashboard: "仪表盘",
    agents: "Agent 管理",
    trace: "链路追踪",
    "version-analysis": "版本分析",
    fault: "智能诊断",
    quality: "可靠性与性能",
    infra: "推理 Infra",
    dataset: "评测数据集",
    metrics: "评估器",
    eval: "评测执行",
    skills: "Skills Hub",
    "skill-generator": "Skills 生成",
    "skill-eval": "Skills 评测",
    "skill-opt": "Skills 优化",
    "model-registry": "模型注册",
    "web-search": "联网搜索",
    "version-management": "版本管理",
    "access-install": "安装指导",
    "agent-ras-trace": "可靠性观测",
    "agent-ras-fault-injection": "故障注入与评测",
  };

  function setActive(route) {
    document.querySelectorAll(".nav-link").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-route") === route);
    });
  }

  function closeChipMenus() {
    document.querySelectorAll(".chip-menu").forEach((m) => m.remove());
  }

  function openChipMenu(btn) {
    closeChipMenus();
    let options = [];
    try {
      options = JSON.parse(btn.getAttribute("data-options") || "[]");
    } catch {
      return;
    }
    const value = btn.getAttribute("data-value");
    const menu = document.createElement("div");
    menu.className = "chip-menu";
    menu.innerHTML = options
      .map(
        ([v, l]) =>
          `<button type="button" class="${v === value ? "selected" : ""}" data-opt="${v}">${l}</button>`
      )
      .join("");
    document.body.appendChild(menu);
    const rect = btn.getBoundingClientRect();
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-opt]");
      if (!opt) return;
      const v = opt.getAttribute("data-opt");
      const label = options.find((o) => o[0] === v)?.[1] || v;
      btn.setAttribute("data-value", v);
      btn.querySelector(".chip-val").textContent = label;
      const first = options[0]?.[0];
      const defaultVal = options.find((o) => o[0] === "all") ? "all" : first;
      btn.classList.toggle("active", v !== defaultVal);
      closeChipMenus();
      btn.dispatchEvent(new CustomEvent("chipchange", { bubbles: true, detail: { value: v } }));
    });
  }

  function bindPageInteractions() {
    document.getElementById("btnSidebar")?.addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("collapsed");
    });

    document.getElementById("btnToggleTraceFilters")?.addEventListener("click", () => {
      document.getElementById("traceFilterAside")?.classList.toggle("hidden");
    });

    const listView = document.getElementById("traceListView");
    const detailHost = document.getElementById("traceDetailHost");
    if (listView && detailHost) {
      const showDetail = (id) => {
        const target = detailHost.querySelector(`[data-trace-detail="${CSS.escape(id)}"]`);
        if (!target) {
          UI.toast(`原型：暂无 ${id} 的详情 mock`);
          return;
        }
        listView.hidden = true;
        detailHost.querySelectorAll("[data-trace-detail]").forEach((el) => {
          el.hidden = true;
        });
        target.hidden = false;
        window.scrollTo(0, 0);
      };
      const showList = () => {
        detailHost.querySelectorAll("[data-trace-detail]").forEach((el) => {
          el.hidden = true;
        });
        listView.hidden = false;
      };
      window.__protoShowTraceDetail = showDetail;
      listView.addEventListener("click", (e) => {
        const open = e.target.closest("[data-trace-open]");
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          showDetail(open.getAttribute("data-trace-open"));
        }
      });
      detailHost.addEventListener("click", (e) => {
        if (e.target.closest("[data-trace-back]")) {
          e.preventDefault();
          showList();
          return;
        }
        const span = e.target.closest("[data-span]");
        if (span) {
          const panel = span.closest(".trace-detail");
          panel?.querySelectorAll(".span-row").forEach((r) => r.classList.toggle("selected", r === span));
        }
      });
      const pending = sessionStorage.getItem("protoOpenTrace");
      if (pending) {
        sessionStorage.removeItem("protoOpenTrace");
        showDetail(pending);
      }
    }

    // RAS trace list ↔ detail
    const rasListView = document.getElementById("rasTraceListView");
    const rasDetailHost = document.getElementById("rasTraceDetailHost");
    if (rasListView && rasDetailHost) {
      const showRasDetail = (id) => {
        const target = rasDetailHost.querySelector(`[data-ras-trace-detail="${CSS.escape(id)}"]`);
        if (!target) { UI.toast(`原型：暂无 ${id} 的详情 mock`); return; }
        rasListView.hidden = true;
        rasDetailHost.querySelectorAll("[data-ras-trace-detail]").forEach((el) => { el.hidden = true; });
        target.hidden = false;
        window.scrollTo(0, 0);
      };
      const showRasList = () => {
        rasDetailHost.querySelectorAll("[data-ras-trace-detail]").forEach((el) => { el.hidden = true; });
        rasListView.hidden = false;
      };
      rasListView.addEventListener("click", (e) => {
        const open = e.target.closest("[data-ras-trace-open]");
        if (open) { e.preventDefault(); e.stopPropagation(); showRasDetail(open.getAttribute("data-ras-trace-open")); }
      });
      rasDetailHost.addEventListener("click", (e) => {
        if (e.target.closest("[data-ras-trace-back]")) { e.preventDefault(); showRasList(); return; }
        const span = e.target.closest("[data-span]");
        if (span) {
          const panel = span.closest(".trace-detail");
          panel?.querySelectorAll(".span-row").forEach((r) => r.classList.toggle("selected", r === span));
          const node = span.closest("[data-ras-node]");
          if (node) { node.scrollIntoView({ behavior: "smooth", block: "center" }); }
        }
      });
    }

    // ── RAS stat card filter click ──
    document.querySelectorAll(".ras-stat-card.clickable").forEach((card) => {
      card.addEventListener("click", () => {
        const sev = card.getAttribute("data-ras-sev");
        const currentlyActive = card.classList.contains("active");
        // Deactivate all
        document.querySelectorAll(".ras-stat-card.clickable").forEach((c) => c.classList.remove("active"));
        // Toggle
        if (!currentlyActive) card.classList.add("active");
        // Show/hide clear filter
        const clearBtn = document.querySelector("[data-ras-clear-filter]");
        if (clearBtn) clearBtn.classList.toggle("hidden", currentlyActive);
        // Demo toast
        UI.toast(currentlyActive ? "已清除筛选" : `按 ${card.querySelector(".label").textContent} 筛选（原型示意）`);
      });
    });
    // Clear filter button
    document.querySelector("[data-ras-clear-filter]")?.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelectorAll(".ras-stat-card.clickable.active").forEach((c) => c.classList.remove("active"));
      e.target.classList.add("hidden");
      UI.toast("已清除筛选");
    });

    // ── Fault Injection: Platform selector ──
    document.getElementById("platformSel")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-platform]");
      if (!btn) return;
      const plat = btn.getAttribute("data-platform");
      document.querySelectorAll("[data-platform]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      UI.toast(`已切换至平台: ${plat}（原型示意）`);
    });

    // ── Fault Injection: Catalog category toggle ──
    document.getElementById("faultCatalog")?.addEventListener("click", (e) => {
      const toggle = e.target.closest("[data-fault-cat-toggle]");
      if (toggle) {
        const cat = toggle.getAttribute("data-fault-cat-toggle");
        const panel = document.querySelector(`[data-fault-cat-panel="${cat}"]`);
        if (panel) {
          const hidden = panel.style.display === "none";
          panel.style.display = hidden ? "" : "none";
          toggle.classList.toggle("collapsed", !hidden);
        }
        return;
      }
      // Fault item selection
      const item = e.target.closest("[data-fault-id]");
      if (item) {
        const faultId = item.getAttribute("data-fault-id");
        const modeBtn = document.querySelector("[data-inj-mode].active-mode");
        const mode = modeBtn?.getAttribute("data-inj-mode") || "single";

        if (mode === "single") {
          // Deselect all, select clicked
          document.querySelectorAll(".fault-cat-item.selected").forEach((i) => i.classList.remove("selected"));
          item.classList.add("selected");
          // Update config panel
          const selEl = document.getElementById("injSelectedFault");
          if (selEl) {
            selEl.className = "inj-selected-fault";
            selEl.textContent = item.querySelector(".item-name")?.textContent || faultId;
          }
        } else {
          // Batch mode: toggle
          item.classList.toggle("selected");
          const selected = [...document.querySelectorAll(".fault-cat-item.selected")];
          const selEl = document.getElementById("injSelectedFault");
          if (selEl) {
            if (!selected.length) {
              selEl.className = "inj-selected-fault-empty";
              selEl.textContent = "请从左侧目录勾选多个故障";
            } else {
              selEl.className = "inj-batch-tags";
              selEl.innerHTML = selected.map((s) => {
                const name = s.querySelector(".item-name")?.textContent || "";
                return `<span class="inj-batch-tag">${name}</span>`;
              }).join("");
            }
          }
        }
      }
    });

    // ── Fault Injection: Mode toggle ──
    document.querySelectorAll("[data-inj-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-inj-mode]").forEach((b) => b.classList.remove("active-mode"));
        btn.classList.add("active-mode");
        // Reset selections
        document.querySelectorAll(".fault-cat-item.selected").forEach((i) => i.classList.remove("selected"));
        const selEl = document.getElementById("injSelectedFault");
        if (selEl) {
          selEl.className = "inj-selected-fault-empty";
          selEl.textContent = btn.getAttribute("data-inj-mode") === "single" ? "请从左侧目录选择故障类型" : "请从左侧目录勾选多个故障";
        }
      });
    });

    // ── Fault Injection: Inject button ──
    document.getElementById("btnInject")?.addEventListener("click", () => {
      const selected = document.querySelector(".fault-cat-item.selected");
      const target = document.getElementById("injTargetAgent")?.value?.trim();
      if (!selected) { UI.toast("请先从左侧目录选择一个故障类型"); return; }
      if (!target) { UI.toast("请输入目标 Agent ID"); return; }
      const faultName = selected.querySelector(".item-name")?.textContent || "";
      UI.toast(`已提交注入任务（Mock）：${faultName} → ${target}`);
      // Deselect
      selected.classList.remove("selected");
      const selEl = document.getElementById("injSelectedFault");
      if (selEl) { selEl.className = "inj-selected-fault-empty"; selEl.textContent = "请从左侧目录选择故障类型"; }
      if (document.getElementById("injTargetAgent")) document.getElementById("injTargetAgent").value = "";
    });

    // Fault list ↔ detail panels
    const faultList = document.querySelector(".fault-list");
    if (faultList) {
      const showFault = (id) => {
        faultList.querySelectorAll("[data-fault-id]").forEach((el) => {
          el.classList.toggle("active", el.getAttribute("data-fault-id") === id);
        });
        document.querySelectorAll("[data-fault-panel]").forEach((p) => {
          p.hidden = p.getAttribute("data-fault-panel") !== id;
        });
      };
      const applyFaultFilter = () => {
        const ag = document.getElementById("ftAg")?.getAttribute("data-value") || "all";
        const ty = document.getElementById("ftTy")?.getAttribute("data-value") || "all";
        const items = [...faultList.querySelectorAll("[data-fault-id]")];
        let firstVisible = null;
        items.forEach((item) => {
          const typeOk = ty === "all" || item.getAttribute("data-fault-type") === ty;
          const agentOk = ag === "all" || item.getAttribute("data-fault-agent") === ag;
          const show = typeOk && agentOk;
          item.hidden = !show;
          if (show && !firstVisible) firstVisible = item;
        });
        const active = faultList.querySelector("[data-fault-id].active");
        if (active?.hidden && firstVisible) {
          showFault(firstVisible.getAttribute("data-fault-id"));
        }
      };
      faultList.addEventListener("click", (e) => {
        const item = e.target.closest("[data-fault-id]");
        if (!item || item.hidden) return;
        showFault(item.getAttribute("data-fault-id"));
      });
      document.getElementById("ftAg")?.addEventListener("chipchange", applyFaultFilter);
      document.getElementById("ftTy")?.addEventListener("chipchange", applyFaultFilter);
    }

    // Eval history ↔ main panel
    const evalSide = document.querySelector(".eval-side");
    if (evalSide) {
      evalSide.addEventListener("click", (e) => {
        const item = e.target.closest("[data-eval-id]");
        if (!item) return;
        const id = item.getAttribute("data-eval-id");
        evalSide.querySelectorAll("[data-eval-id]").forEach((el) => el.classList.toggle("active", el === item));
        document.querySelectorAll("[data-eval-panel]").forEach((p) => {
          p.hidden = p.getAttribute("data-eval-panel") !== id;
        });
      });
    }

    // Skills filter actually filters cards
    const applySkFilter = () => {
      const bar = document.querySelector(".sk-filter");
      if (!bar) return;
      const on = bar.querySelector("button.on");
      const tag = on?.getAttribute("data-sk-filter") || "all";
      const q = (document.getElementById("skSearch")?.value || "").trim().toLowerCase();
      let n = 0;
      document.querySelectorAll(".sk-card[data-sk-tag]").forEach((card) => {
        const t = card.getAttribute("data-sk-tag");
        const name = (card.getAttribute("data-sk-name") || "").toLowerCase();
        const desc = (card.getAttribute("data-sk-desc") || "").toLowerCase();
        const tagOk = tag === "all" || t === tag;
        const qOk = !q || name.includes(q) || desc.includes(q);
        const show = tagOk && qOk;
        card.hidden = !show;
        if (show) n++;
      });
      const countEl = document.getElementById("skCountVal");
      if (countEl) countEl.textContent = String(n);
    };
    document.querySelectorAll(".sk-filter").forEach((bar) => {
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        bar.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        applySkFilter();
      });
    });
    document.getElementById("skSearch")?.addEventListener("input", applySkFilter);

    // Agents filter chips
    const applyAgFilter = () => {
      const shell = document.querySelector(".agents-shell");
      if (!shell) return;
      const plat = document.getElementById("agPlat")?.getAttribute("data-value") || "all";
      const layer = document.getElementById("agLayer")?.getAttribute("data-value") || "all";
      const own = document.getElementById("agOwn")?.getAttribute("data-value") || "all";
      let n = 0;
      const cards = shell.querySelectorAll(".agent-card-v2");
      cards.forEach((card) => {
        const ok =
          (plat === "all" || card.getAttribute("data-ag-plat") === plat) &&
          (layer === "all" || card.getAttribute("data-ag-layer") === layer) &&
          (own === "all" || card.getAttribute("data-ag-own") === own);
        card.hidden = !ok;
        if (ok) n++;
      });
      const hint = document.getElementById("agCountHint");
      if (hint) hint.textContent = `显示 ${n} / ${cards.length} 个 Agent`;
    };
    document.querySelector(".agents-filter-box")?.addEventListener("chipchange", applyAgFilter);
    document.querySelector("[data-ag-clear]")?.addEventListener("click", (e) => {
      e.preventDefault();
      const resets = [
        ["agPlat", "all", "全部"],
        ["agLayer", "all", "全部"],
        ["agOwn", "all", "全部"],
        ["agTime", "1h", "近 1 小时"],
        ["agSort", "lastExecutedDesc", "最近执行 ↓"],
      ];
      resets.forEach(([id, val, label]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.setAttribute("data-value", val);
        const v = btn.querySelector(".chip-val");
        if (v) v.textContent = label;
        const opts = JSON.parse(btn.getAttribute("data-options") || "[]");
        const first = opts[0]?.[0];
        const defaultVal = opts.find((o) => o[0] === "all") ? "all" : first;
        btn.classList.toggle("active", val !== defaultVal);
      });
      applyAgFilter();
      UI.toast("已清除筛选");
    });
    applyAgFilter();

    document.querySelectorAll("[data-tabs]").forEach((tabs) => {
      tabs.addEventListener("click", (e) => {
        const tab = e.target.closest("[data-tab]");
        if (!tab) return;
        const name = tab.getAttribute("data-tab");
        tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
        const panels = tabs.parentElement.querySelector(".tab-panels");
        panels?.querySelectorAll(".tab-panel").forEach((p) => {
          p.classList.toggle("active", p.getAttribute("data-panel") === name);
        });
      });
    });
  }

  function navigate(route) {
    if (!TITLES[route]) route = "trace";
    closeChipMenus();
    setActive(route);
    const root = document.getElementById("viewRoot");
    root.innerHTML = Pages.render(route);
    bindPageInteractions();
    history.replaceState({ route }, "", `#${route}`);
    document.title = `${TITLES[route]} · Agent Insight 原型`;
  }

  window.navigateProto = navigate;

  renderNav();

  // restore rel toggle
  UI.setShowRel(UI.getShowRel());
  const btnRel = document.getElementById("btnRel");
  function syncRelBtn() {
    const on = UI.getShowRel();
    btnRel.textContent = on ? "对照 ON" : "对照 OFF";
    btnRel.classList.toggle("on", on);
  }
  syncRelBtn();
  btnRel.addEventListener("click", () => {
    UI.setShowRel(!UI.getShowRel());
    syncRelBtn();
  });

  document.getElementById("sidebar").addEventListener("click", (e) => {
    const group = e.target.closest("[data-group]");
    if (group && group.hasAttribute("data-group")) {
      const key = group.getAttribute("data-group");
      const panel = document.querySelector(`[data-group-panel="${key}"]`);
      if (panel) {
        const hide = panel.style.display === "none";
        panel.style.display = hide ? "" : "none";
        group.querySelector(".chev").textContent = hide ? "▾" : "▸";
      }
      return;
    }
    const treeBtn = e.target.closest(".nav-tree-toggle");
    if (treeBtn) {
      const key = treeBtn.getAttribute("data-tree");
      const panel = document.querySelector(`[data-tree-panel="${key}"]`);
      const open = panel.classList.toggle("open");
      treeBtn.classList.toggle("open", open);
      treeBtn.querySelector(".chev").textContent = open ? "▾" : "▸";
      return;
    }
    const linkEl = e.target.closest("[data-route]");
    if (linkEl) navigate(linkEl.getAttribute("data-route"));
  });

  document.getElementById("viewRoot").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-chip-select]");
    if (chip) {
      e.preventDefault();
      openChipMenu(chip);
      return;
    }
    if (e.target.closest("[data-demo]")) {
      e.preventDefault();
      UI.toast("原型示意：未接真实 API");
      return;
    }
    const openTrace = e.target.closest("[data-open-trace]");
    if (openTrace) {
      e.preventDefault();
      sessionStorage.setItem("protoOpenTrace", openTrace.getAttribute("data-open-trace"));
      navigate("trace");
      return;
    }
    const goto = e.target.closest("[data-goto]");
    if (goto) navigate(goto.getAttribute("data-goto"));
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-chip-select]") && !e.target.closest(".chip-menu")) {
      closeChipMenus();
    }
  });

  document.getElementById("btnTheme").addEventListener("click", () => {
    const html = document.documentElement;
    const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
    html.setAttribute("data-theme", next);
    document.getElementById("btnTheme").textContent = next === "dark" ? "☀" : "☾";
  });

  document.getElementById("btnLocale").addEventListener("click", () => {
    const btn = document.getElementById("btnLocale");
    btn.textContent = btn.textContent === "EN" ? "中" : "EN";
  });

  const hash = (location.hash || "#trace").slice(1);
  navigate(TITLES[hash] ? hash : "trace");
})();
