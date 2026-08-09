# Agent RAS 内核/能力分层与故障域插件化（规划）

> 范围：仓根 `agent_ras/` 的 L0/L1 重构。`core/` 下的 `agents/ detectors/ recovery/`
> **整体上移一层**（内部文件结构原样保留，skills 不迁移），`core/` 收敛为内核；
> 同时把 detector 注册入口统一，消灭双编排点登记分叉；`ras_embed/` **更名为 `ras_runtime/`**（D7）。
>
> 约束（用户明确）：**不改变 `detectors/` 内部文件结构**；**skills 不移动到 `agents/`**。

---

## 1. 背景与问题

### 1.1 现状：`core/` 混合了两类东西

| 类别 | 内容 |
|------|------|
| 内核（契约 + 编排） | `models` `config` `host_control` `monitor` `window` `signal_builder` `reporter` |
| 能力实现（故障域知识） | `core/detectors/`、`core/recovery/`、`core/agents/` |

### 1.2 新增一个故障域的触点清单

| | 现状（8+ 处） | 重构后（3~5 处） |
|---|---|---|
| 1 | `core/config.py` 加 `*Config` 字段 | 同左（**有意保留**，见 D6） |
| 2 | `core/models.py` 加 `AnomalyKind` 成员 | 同左（可选，见 D1） |
| 3 | `core/detectors/registry.py` 加 builder | `detectors/registry.py` 加一行 builder |
| 4 | `core/recovery/engine.py` 加 `DEFAULT_KIND_OVERRIDES` | 同左（可选；`recovery/engine.py` 原样） |
| 5 | `core/recovery/robustness_prompt.py` 加文案 | 同左（原样不拆） |
| 6 | `core/agents/base.py` 注册 `FAULT_DOMAIN_SKILLS` | 同左（仅需要语义 skill 的域） |
| 7 | `ras_embed/session_hub.py` 加 `SessionState` 字段 + payload 解析分支 | **消除**（注册表驱动，D5） |
| 8 | skills 目录 | 同左（位置不变） |

**核心收益在第 7 行**：新增 detector 不再需要碰 `session_hub.py`，也不存在
factory / SessionHub 两处登记对齐问题。

### 1.3 结构性问题（本次要解决的）

| # | 问题 | 位置 | 本次是否解决 |
|---|------|------|--------------|
| C1 | `SessionState` 把 detector 硬编码为 `thinking`/`repeat` 两个字段 + `force_thinking_loop=True` 兼容 hack；与 openjiuwen factory 的 enabled 门控语义不一致 | `session_hub.py:76,104` | ✅ 解决（D5） |
| C2 | 内核漏入能力细节：`monitor.py:46` import `skill_verdicts`；`monitor.py:637-690` 硬编码 `FAULT_DOMAIN_LLM_THINKING_LOOP` fallback | `core/monitor.py` | ✅ 解决（D4，内容级修改，不动文件结构） |
| C3 | 协议与实现同目录（`Detector` 在 `detectors/base.py` 等），core 与能力包相互 import | — | ❌ 接受现状（D2），仅路径随上移变化 |
| C4 | skill 路径按 role 分裂两处（`detectors/skills` / `recovery/skills`），`ROLE_SKILL_DIRS` 硬编码 | `agents/base.py:64` | ❌ 不动（用户约束），路径计算随上移自然成立 |

## 2. 目标与非目标

**目标**

- G1：`core/` 瘦身为内核文件集合（`models / config / host_control / monitor / window / signal_builder / reporter`），不再包含故障域实现目录
- G2：`agents/ detectors/ recovery/` 三目录**整体上移一层**，内部文件结构、skills 位置原样保留
- G3：detector 注册入口唯一化——SessionHub 与 openjiuwen factory 同走 `detectors/registry.build_member_detectors`；消灭 `force_thinking_loop`；`SessionState` 泛化
- G4：对外稳定契约不破：`core/__init__` 公共导出、`ras_embed.call` wire JSON、配置文件键名

**非目标（明确不做，记录为未来可选）**

- 不抽 `core/ports.py` 协议层（`Detector` / `AgentAdapter` 协议原地保留在 `detectors/base.py` / `agents/base.py`）
- 不迁移 skills（`detectors/skills/`、`recovery/skills/` 位置不变）
- 不拆 `robustness_prompt.py`；不把配置模型迁出 `core/config.py`
- 不做 Monitor vs SessionHub 编排核合并；不做 entry_points 动态发现
- 不改 `AnomalyKind` 为动态字符串（D1）

## 3. 目标架构

### 3.1 目录布局（与现状的唯一差异：三个目录上移一层）

```text
agent_ras/
  core/                    # 内核
    __init__.py            # 公共 API（导出保持不变）
    models.py  config.py  host_control.py
    monitor.py             # 深挂载编排核（D4 瘦身，仅内容修改）
    window.py  signal_builder.py  reporter.py
  detectors/               # 原 core/detectors/ 整体上移，内部结构不变
    base.py  registry.py  repeat_tool.py  llm_thinking_loop.py  skill_verdicts.py
    skills/llm-loop-detection/SKILL.md
  recovery/                # 原 core/recovery/ 整体上移，内部结构不变
    engine.py  operations.py  state.py  robustness_prompt.py
    skills/llm-loop-review/SKILL.md
  agents/                  # 原 core/agents/ 整体上移，内部结构不变
    base.py  ras_agents.py  host_callback_adapter.py
  ras_runtime/             # 原 ras_embed/ 更名（D7），内部结构不变
  platform_adapter/  config/  scripts/  tests/   # 结构不变，仅 import 更新
```

### 3.2 依赖关系（import 图与现状一致，仅路径变化）

```text
core/monitor.py   ──▶  detectors.base / recovery.engine / agents.base   （维持现状）
core/config.py    ──▶  recovery.engine（RecoveryAction / DEFAULT_SEVERITY_ACTIONS）
detectors/*       ──▶  core.models / core.config / agents
recovery/*        ──▶  core.models / core.host_control
ras_embed / platform_adapter  ──▶  core + detectors + recovery + agents
```

明确接受：**core（编排器）import 能力包**这一现状不改造。严格分层（协议抽离、
core 零能力依赖）需要抽 `ports.py` 并改写 Monitor 接口，代价与收益不匹配，放弃。

`agents/base.py:62` 的 `_AGENT_RAS_ROOT = Path(__file__).parent.parent` 在上移后
解析为 `agent_ras/`，`ROLE_SKILL_DIRS` 指向 `detectors/skills` / `recovery/skills`
**自然成立**，skills 路径零改动（C4 不处理也不破）。

## 4. 关键设计决策

### D1：`AnomalyKind` 保留为 core 枚举

它是 detector ↔ recovery ↔ wire actions ↔ Insight 看板的公共契约。新域需要新 kind
时在内核枚举加成员，不做动态注册。

### D2：协议原地保留，接受 core → 能力包 import

`Detector` / `AsyncRecoveryDetector` 留在 `detectors/base.py`，`AgentAdapter` 留在
`agents/base.py`，`RecoveryAction` 留在 `recovery/engine.py`。core 的 `__init__.py`
与 `monitor.py` 继续 import 它们——与现状同构，只是路径从 `core.detectors.*`
变为 `detectors.*`。

### D3：三个目录纯平移

`git mv core/detectors detectors`（recovery / agents 同理），文件内容在搬家 commit
中**零编辑**（import 改写单独一个 commit 或同 commit 机械替换，见 §5）。

### D4：Monitor 瘦身（内容级，不改文件结构）

- 删除 `monitor.py:46` 对 `detectors.skill_verdicts` 的直接 import：L3 reviewer 的
  verdict 解析经 detector 的 `AsyncRecoveryDetector` 回调带回，或经 `detectors/registry`
  提供的解析钩子获取。
- `_fault_domain_for_pending`（`monitor.py:637`）的 thinking-loop 硬编码 fallback
  改为按 `anomaly.kind` 经注册表反查域；查不到走兜底 notice。
- 清理残留的 kind 字面量分支，恢复决策一律 policy 驱动。

### D5：注册入口统一 + SessionState 泛化（本次核心收益）

- `SessionHub` 与 openjiuwen `factory` 统一走 `detectors/registry.build_member_detectors(config, agents)`（已存在），enabled 门控语义完全一致。
- `SessionState` 的 `thinking` / `repeat` 硬编码字段泛化为 `detectors: list[Detector]`；observe 扇出遍历列表。
- 删除 `force_thinking_loop` 参数。**有意的行为修正**：协议路径历史上 thinking-loop
  恒装（忽略 `enabled: false`）；重构后尊重配置（默认 enabled=true，行为不变；
  显式关闭才真正不装）。PR 描述中显式声明。
- `_config_from_payload` 的逐键白名单改为按注册表域名单分发 payload 子 dict
  （配置模型仍在 `core/config.py`，键名不变），新增域不再改 `session_hub.py`。

### D6：配置模型留在 `core/config.py`

`RepeatToolConfig` / `LlmThinkingLoopConfig` 不迁移。代价：新增域仍需在
`core/config.py` 加一个字段（触点 1 保留）。换来 `DetectorsConfig` 强类型校验、
宿主配置键名稳定、本次 diff 可控。

### D7：`ras_embed/` 更名为 `ras_runtime/`

原名的问题是「embed」只描述了嵌入形态，没说明它是**进程内运行时**（FFI 门面 +
embed loop + SessionHub 编排核 + 旁路 push）。新名与文档既有术语
「进程内 runtime」一致。内部文件结构不变。

> 注：2026-08-07 的 `037bd69`（扩展多平台 inproc）已把 IPC 迁出本包——
> 原 `ipc.py` / `ipc_worker.py` 移至 `platform_adapter/common/transport/subprocess_ipc/`，
> 本包公共 API 收缩为 `call / ensure_runtime / reset_runtime_for_tests`，更名面相应缩小。

**契约面盘点（改名即改约，全部仓内同步，不留别名兼容层）**：

| 引用面 | 位置 |
|--------|------|
| JS FFI 字符串契约 | `platform_adapter/common/python_bridge.js`：`PyRun_SimpleString` 内 `from ras_embed import call` |
| Python client | `platform_adapter/common/ras_client.py`、`platform_adapter/xiaoo/hooks.py`、`xiaoo/hooker/hooker_main.py`、`common/insight_anomaly_reporter.py` |
| transport 层 | `common/transport/subprocess_ipc/worker.py`（`from ras_embed.facade import call`）、`client.py` 内 docstring/错误消息字样 |
| 打包 | `pyproject.toml` 的 `packages.find` include |
| 测试 | `tests/unit_tests/ras_embed/` → `ras_runtime/`；harness 下同名目录 |
| 文档 | `architecture.md` §4 全节、`modules/ras-embed.md` → 更名 `modules/ras-runtime.md`、guides |

**保留不改**：`transport/subprocess_ipc/client.py` 的 socket 文件名 `ras_embed.sock`
（磁盘上的进程间契约，避免与残留旧 worker 进程不兼容）；仅包名变更。

**仓外风险**：若有仓外部署/手写代码 pin 了 `from ras_embed import ...`（独立维护的
xiaoo / openjiuwen 环境），需同步通知。仓内分发的桥接代码随安装器走，自洽。

## 5. 迁移计划

### P1 结构分层（纯搬家，无行为变化）

1. `git mv` 三目录上移 + `git mv ras_embed ras_runtime`；`agents/base.py` 的 `_AGENT_RAS_ROOT` 无需改（上移后解析不变）
2. 全量 import 改写：`core.detectors.*` → `detectors.*`、`core.recovery.*` → `recovery.*`、`core.agents.*` → `agents.*`、`ras_embed` → `ras_runtime`（约 40 个 py + JS 桥接字符串 + 测试目录更名）
3. `pyproject.toml` 的 `packages.find` include 改为 `core*` `detectors*` `recovery*` `agents*` `ras_runtime*` `platform_adapter*`
4. 跑全量单测确认零行为变化

### P2 注册入口统一（机制切换，含一处行为修正）

5. D4：Monitor 摘除 `skill_verdicts` 直接依赖与域名硬编码
6. D5：`SessionState` 泛化为 `detectors: list`；删除 `force_thinking_loop`；`_config_from_payload` 注册表驱动分发
7. 单测 + E2E 全量验证（§7）

### 不做（未来可选，另行立项）

- `core/ports.py` 协议抽离（严格分层）
- skills 统一目录、`robustness_prompt` 拆分、配置模型迁入域文件（完整单文件插件形态）
- Monitor 与 SessionHub 编排核合并

## 6. 兼容性

| 面 | 结论 |
|----|------|
| `core/__init__.py` 公共导出 | 不变（`AgentRASConfig` / `HostControl` / `AgentAdapter` / 模型 / `RecoveryAction`，re-export 路径内部调整） |
| `ras_embed` 包名 | **破**：更名 `ras_runtime`；`call` wire JSON 本身不变，仅 import 路径变（D7 契约面全仓同步，无别名兼容层） |
| 宿主配置键 | 不变（新增「显式 enabled:false 生效」语义修正，PR 声明） |
| skills 磁盘路径 | 包内相对路径不变（`detectors/skills/`、`recovery/skills/` 随目录上移，加载逻辑零改动） |
| 内部 import 路径 | **破**：`core.{detectors,recovery,agents}.*` → `{detectors,recovery,agents}.*`；仓内全部调用方同步改 |
| Insight 契约 | 不变（AnomalyKind 值不变） |

## 7. 验证计划

1. `cd agent_ras && python -m pytest tests -q` 全量单测
2. E2E（结构改动触及全部运行路径，必须做端到端验证）：
   - 深挂载：`python agent_ras/scripts/smoke_l3_runtime.py`、`e2e_l3_thinking_dead_loop.py`、`e2e_l2_similar_clauses.py`
   - 协议 inproc：`bash agent_ras/scripts/smoke_inproc.sh`（显式 `unset LD_PRELOAD` 路径）
   - xiaoO：`e2e_xiaoo_inproc_harness.py` / `e2e_xiaoo_cli.py`
   - 核对：thinking-loop 命中后 wire actions 与重构前一致；`detectors.llm_thinking_loop.enabled=false` 在 SessionHub / factory 两条路径下同语义（均不装）
3. 未跑 E2E 前不得在 PR 宣称完成

## 8. 文档同步清单

- [ ] `docs/agent-ras/designs/architecture.md`：§3 源码目录、§4.4 文件调用图（`core/detectors` → `detectors` 等）
- [ ] `docs/agent-ras/designs/modules/detectors.md`：路径更新；「扩展指南」改为新流程（detectors/ 新文件 + registry 一行 + config 字段，**不再**提 SessionState 两边登记）
- [ ] `docs/agent-ras/designs/modules/recovery.md`、`ras-embed.md`（更名 `ras-runtime.md`）、`monitor.md`：路径与 SessionState 变化
- [ ] `docs/agent-ras/guides/` 各平台页、`agent_ras/README.md`、`AGENTS.md` §7（如提及目录）

## 9. 风险

| 风险 | 缓解 |
|------|------|
| 大 diff 冲击在途分支 | P1（搬家）/P2（机制）分两个 commit；P1 纯 `git mv` + import 替换 |
| `enabled:false` 语义修正影响存量宿主 | 默认全启用→行为不变；仅显式关闭者变化，PR 显式声明 |
| 分层纯度未达成（core 仍 import 能力包） | 明确记录为已接受取舍；未来如需严格分层再抽 ports（§5「不做」） |
| 仓外 pin `ras_embed` 包名 | 改名前确认仓外部署无手写引用；PR 描述显式声明包名变更 |
| git blame 噪音 | 搬家 commit 不做逻辑编辑，便于 `git log --follow` |
