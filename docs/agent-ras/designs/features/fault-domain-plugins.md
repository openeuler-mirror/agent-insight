# 故障域自包含插件化（规划）

> 范围：仓根 `agent_ras/`。把「故障模式 = 检测 + 恢复策略 + 文案 + Skill」收成**自包含插件包**；框架启动时目录扫描自动注册。  
> 目标态：新增故障模式只需新增 `fault_domains/<id>/` 下文件与对应文档，**不修改**框架已有源码。  
> 状态：**前置已落地，插件方案规划中**。前置「分层搬家 + 注册入口统一」已完成（`b26d497` 三目录上移 + `ras_embed`→`ras_runtime`、`fc1d5fd` 注册表收口，2026-08-09）；自包含 `fault_domains/` 插件包未落地。  
> 版本：v0.2 · 2026-08-09

---

## 一句话结论

| 项目 | 约定 |
|------|------|
| 插件形态 | 自包含目录 + `detector.py`（含 `PLUGIN` 元数据） |
| 是否需要 manifest.yaml | **不需要**（元数据唯一真源 = `PLUGIN`） |
| 发现方式 | 扫描 `fault_domains/*/detector.py`，`importlib` 读 `PLUGIN` |
| 新域触点 | 仅插件目录 + 设计文档；零改 registry / config 字段 / models 枚举 / SessionHub |

---

## 1. 背景与问题

### 1.1 今天新增一个故障域要改哪里

```mermaid
flowchart TB
  subgraph today [现状_8plus_触点]
    C[core/config.py_加Config字段]
    K[core/models.py_加AnomalyKind]
    Det[detectors/新文件]
    Reg[detectors/registry.py_加builder]
    Eng[recovery/engine.py_KIND_OVERRIDES]
    Msg[robustness_prompt.py_加文案]
    Sk[agents/base.py_FAULT_DOMAIN_SKILLS]
    Hub[session_hub.py_字段与payload白名单]
  end
  New[新人要加故障模式] --> today
```

| # | 触点 | 文件 | 问题 |
|---|------|------|------|
| 1 | 配置模型 | [`core/config.py`](../../../../agent_ras/core/config.py) | 每域加 `*Config` + `DetectorsConfig` 字段 |
| 2 | Kind 枚举 | [`core/models.py`](../../../../agent_ras/core/models.py) | `AnomalyKind` 硬枚举，新 kind 必改内核 |
| 3 | Detector + 注册 | [`detectors/`](../../../../agent_ras/detectors/) + [`registry.py`](../../../../agent_ras/detectors/registry.py) | 手写 `DETECTOR_BUILDERS` |
| 4 | Recovery 覆盖 | [`recovery/engine.py`](../../../../agent_ras/recovery/engine.py) | `DEFAULT_KIND_OVERRIDES` |
| 5 | 用户文案 | [`robustness_prompt.py`](../../../../agent_ras/recovery/robustness_prompt.py) | 巨型双语字典 |
| 6 | Skill 绑定 | [`agents/base.py`](../../../../agent_ras/agents/base.py) | `FAULT_DOMAIN_SKILLS` / `_KIND_TO_FAULT_DOMAIN` |
| 7 | SessionHub | [`session_hub.py`](../../../../agent_ras/ras_runtime/session_hub.py) | `thinking`/`repeat` 硬字段 + payload 白名单 |
| 8 | Monitor 兜底 | [`monitor.py`](../../../../agent_ras/core/monitor.py) | 域名 / kind 字面量 fallback |

结果：故障域知识散落在「内核 + 能力 + 编排」三处，**无法插件式扩展**。

### 1.2 与旧规划文档的关系

此前同名文档聚焦「`core/` 下三目录上移 + 注册入口统一」，并**明确不做**动态发现与配置迁出。  
部分结构目标（`detectors/` / `recovery/` / `agents/` 顶层、`ras_runtime/`）仓内已基本到位；**本版升级为真正的自包含插件化**，并推翻旧 D1（Kind 保留枚举）与「不做 entry_points / 配置迁出」。

```mermaid
flowchart LR
  P0[旧规划_分层搬家] --> P1[注册入口统一]
  P1 --> P2[本方案_自包含插件]
  P2 --> Goal[新域只加目录]
```

---

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 |
|----|------|
| G1 | 故障域 = 一个目录：检测实现 + `PLUGIN` 元数据 + 可选文案/Skill + 说明文档 |
| G2 | 框架启动扫描自动注册；**新域零改** registry / config 静态字段 / models / SessionHub / Monitor |
| G3 | 无独立 `manifest.yaml`；元数据与工厂同文件，避免 YAML/Python 双源 |
| G4 | 深挂载 Monitor 与协议 SessionHub **共用** `build_member_detectors`；`enabled` 语义一致 |
| G5 | Wire 契约不变（`abort_stream` / `emit_notice` / `push_steering`）；Insight 旁路 kind 仍为字符串 |

### 2.2 非目标

- 不做纯声明式检测（算法仍在插件 `detector.py`）。
- 不新增 wire 动作类型；不合并 Monitor 与 SessionHub 编排核。
- Insight [`fault-mode-catalog.ts`](../../../../src/lib/ingest/ras/fault-mode-catalog.ts) / 能力配置 UI **本阶段不自动发现**（环内先生效；看板另立项）。
- 不要求仓外非 Python 工具只读枚举域列表。

---

## 3. 目标架构总览

### 3.1 逻辑结构

```mermaid
flowchart TB
  subgraph L3 [L3_platform_adapter]
    Host[HostControl]
  end
  subgraph L1 [L1_ras_runtime]
    Hub[SessionHub]
  end
  subgraph L0core [L0_core_内核]
    Mon[Monitor]
    Cfg[AgentRASConfig]
    Models[Signal_Anomaly_str_kind]
  end
  subgraph L0cap [L0_能力框架]
    Loader[FaultDomainLoader]
    Base[detectors/base_skill_verdicts]
    RecEng[recovery/engine_operations]
  end
  subgraph plugins [fault_domains_插件树]
    T[llm_thinking_loop]
    R[repeat_tool]
    N[新域_只加目录]
  end
  Host --> Hub
  Host --> Mon
  Hub --> Loader
  Mon --> Loader
  Loader --> plugins
  Loader --> RecEng
  Hub --> Base
  Mon --> Base
  Cfg --> Loader
  plugins --> Models
```

**依赖方向**：编排（Monitor / SessionHub）→ Loader → 各插件；插件只依赖 `core.models` / `detectors.base` / `agents` / `fault_domains.types`，**禁止** import 宿主 SDK。

### 3.2 目录布局（目标态）

```text
agent_ras/
  core/                      # 内核：models / config / monitor / host_control / …
  detectors/                 # 协议与共享算法：base.py / skill_verdicts.py /（通用工具）
  recovery/                  # 通用恢复引擎 + operations（无域专属字典膨胀）
  agents/                    # AgentAdapter / RASAgents；skills 表由 Loader 填充
  fault_domains/             # ★ 插件根
    types.py                 # FaultDomainPlugin / RecoverySpec
    loader.py                # 扫描 · 注册 · build_member_detectors
    _template/               # 脚手架（_ 前缀不加载）
      detector.py
      messages.yaml.example
      README.md
    llm_thinking_loop/       # 内置域迁入
      detector.py            # PLUGIN + Detector
      messages.yaml
      skills/…
      README.md
    repeat_tool/
      detector.py
      messages.yaml
      README.md
    <new_domain>/            # 新域只加这里
  ras_runtime/               # SessionHub / facade（SessionState.detectors: list）
  platform_adapter/
```

### 3.3 插件包内部结构

```mermaid
flowchart TB
  subgraph pkg ["fault_domains/<domain_id>/"]
    Det["detector.py\nPLUGIN + factory + Detector"]
    Msg["messages.yaml\n可选 cn/en 文案"]
    Sk["skills/\n可选 detection/recovery"]
    Rd["README.md\n人读说明"]
  end
  Det -->|必填| Loader[FaultDomainLoader]
  Msg -.->|可选合并| MsgTable[文案_lookup]
  Sk -.->|按 PLUGIN.skills 解析| Agents[RASAgents]
  Rd -.->|不参与加载| Human[开发者/评审]
```

| 文件 | 必填 | 职责 |
|------|------|------|
| `detector.py` | ✅ | 导出 `PLUGIN` + `factory` + `Detector` 实现 |
| `messages.yaml` | — | 域专属 steer/notice；缺省走通用模板 |
| `skills/*/SKILL.md` | — | L3 检测 / recovery review |
| `README.md` | 建议 | 场景摘要；复杂需求另写 `docs/agent-ras/designs/features/` |

---

## 4. 核心契约：`PLUGIN`（替代 manifest）

### 4.1 为何不要 manifest.yaml

```mermaid
flowchart LR
  subgraph bad [双源_易漂移]
    Y[manifest.yaml]
    P[detector.py]
    Y -.->|id_kinds_skills| Drift[字段不一致]
    P -.-> Drift
  end
  subgraph good [单源]
    D["detector.py\nPLUGIN 唯一真源"]
  end
```

| 原设想 manifest 职责 | 落点 |
|----------------------|------|
| id / kinds / skills / recovery / anchor | `PLUGIN` |
| config schema | `PLUGIN.config_model`（Pydantic） |
| entry 模块 / 工厂名 | 约定文件 `detector.py` + `PLUGIN.factory` |
| 人读说明 | `README.md` / designs（不参与加载） |

### 4.2 `FaultDomainPlugin` 形状

```python
# fault_domains/types.py（示意）
@dataclass(frozen=True)
class RecoverySpec:
    kind_overrides: Mapping[str, Sequence[RecoveryAction]]
    stream_kinds: Sequence[str] = ()   # 走 suppress / abort 分支的 kind
    anchor: Literal["llm", "tool"] = "llm"

@dataclass(frozen=True)
class FaultDomainPlugin:
    id: str                              # == detector.name / 宿主 config 键
    version: int
    enabled_by_default: bool
    kinds: Sequence[str]
    kind_to_domain: Mapping[str, str]
    skills: Mapping[str, str]            # detection / recovery（可缺 recovery）
    recovery: RecoverySpec
    config_model: type[BaseModel]
    factory: Callable[[BaseModel, RASAgents], Detector | None]
```

### 4.3 域内示例（示意）

```python
# fault_domains/analysis_paralysis/detector.py
class AnalysisParalysisConfig(BaseModel):
    enabled: bool = True
    trigger_window_chars: int = Field(default=2000, ge=100)

def build_detector(cfg: AnalysisParalysisConfig, agents: RASAgents) -> Detector | None:
    if not cfg.enabled:
        return None
    return AnalysisParalysisDetector(cfg, agents=agents)

PLUGIN = FaultDomainPlugin(
    id="analysis_paralysis",
    version=1,
    enabled_by_default=True,
    kinds=("analysis_paralysis", "analysis_paralysis_severe"),
    kind_to_domain={
        "analysis_paralysis": "analysis_paralysis",
        "analysis_paralysis_severe": "analysis_paralysis",
    },
    skills={
        "detection": "analysis-paralysis-detection",
        "recovery": "analysis-paralysis-review",
    },
    recovery=RecoverySpec(
        kind_overrides={
            "analysis_paralysis": [
                RecoveryAction.OBSERVE_ONLY,
                RecoveryAction.INJECT_STEERING,
            ],
            "analysis_paralysis_severe": [
                RecoveryAction.REPORT_TO_USER,
                RecoveryAction.INJECT_STEERING,
                RecoveryAction.SUPPRESS_STREAM,
            ],
        },
        stream_kinds=("analysis_paralysis", "analysis_paralysis_severe"),
        anchor="llm",
    ),
    config_model=AnalysisParalysisConfig,
    factory=build_detector,
)
```

**规则摘要**

- `Anomaly.kind` ∈ `PLUGIN.kinds`；`Anomaly.detector` == `PLUGIN.id`。
- L3 调用 `skill_for(PLUGIN.id, "detection")`（表由 Loader 填充）。
- 禁止 import 宿主 SDK。

---

## 5. 发现与加载流程

### 5.1 扫描规则

| 规则 | 说明 |
|------|------|
| 默认根 | `agent_ras/fault_domains/` |
| 扩展根 | 环境变量 `RAS_FAULT_DOMAIN_PATHS`（`os.pathsep` 分隔） |
| 合法包 | 子目录含 `detector.py` 且模块导出 `PLUGIN` |
| 忽略 | 目录名以 `_` 开头（如 `_template`） |
| 冲突 | 同 `PLUGIN.id` 后者失败并打错误日志，保留先加载者 |

### 5.2 加载时序

```mermaid
sequenceDiagram
  participant Boot as SessionHub_or_Monitor
  participant L as FaultDomainLoader
  participant FS as filesystem
  participant Mod as detector_module
  participant Reg as RuntimeRegistries

  Boot->>L: ensure_domains_loaded
  L->>FS: list fault_domains/*/detector.py
  loop each_package
    L->>Mod: importlib.import_module
    Mod-->>L: PLUGIN
    L->>L: validate_PLUGIN
    L->>Reg: merge_kinds_skills_policy_messages
  end
  Boot->>L: build_member_detectors_config_agents
  L->>Reg: per_domain_config_model_validate
  L-->>Boot: list_of_Detector
```

### 5.3 Loader 填充的运行时注册表

```mermaid
flowchart LR
  PLUGIN --> Kinds[kind_set]
  PLUGIN --> K2D[kind_to_domain]
  PLUGIN --> Skills[FAULT_DOMAIN_SKILLS]
  PLUGIN --> Pol[kind_overrides]
  PLUGIN --> Stream[stream_kinds]
  PLUGIN --> Anchor[anchor_llm_or_tool]
  MsgYaml[messages.yaml] --> Msgs[message_lookup]
  Kinds --> Guard[observe后kind校验]
  Stream --> Ops[operations_suppress分支]
  Anchor --> HubA[session_hub_锚点选择]
```

对外稳定 API（替换硬编码 [`detectors/registry.py`](../../../../agent_ras/detectors/registry.py)）：

```text
ensure_domains_loaded() -> None
build_member_detectors(config, agents) -> list[Detector]
fault_domain_for_kind(kind) -> str | None
is_stream_kind(kind) -> bool
anchor_for_kind(kind) -> "llm" | "tool" | None
```

---

## 6. 框架一次性改造（之后新域零改）

### 6.1 `Anomaly.kind`：枚举 → 稳定字符串

```mermaid
flowchart LR
  subgraph before [改造前]
    E["AnomalyKind Enum\n加成员=改内核"]
  end
  subgraph after [改造后]
    S["kind: str\n由 PLUGIN.kinds 声明"]
  end
  before --> after
```

- Wire / Insight 仍吃字符串（如 `"llm_thinking_loop"`），**契约值不变**。
- 未知 kind：fail-open 打日志，丢弃或降级 `observe_only`（实现期定一种并单测锁死）。

### 6.2 配置：静态字段 → 按域动态校验

- `DetectorsConfig` 不再为每域加字段；宿主 JSON 保持 `detectors.<domain_id>.*`。
- Loader 用各域 `config_model` 校验；未知键忽略或 warn（与现 `extra` 策略对齐时写明）。
- [`_config_from_payload`](../../../../agent_ras/ras_runtime/session_hub.py) **删除** thinking/repeat 白名单，按已发现域 id 分发。

### 6.3 SessionHub / Monitor 去硬编码

| 现状 | 目标 |
|------|------|
| `SessionState.thinking` / `.repeat` | `detectors: list[Detector]`，observe 扇出 |
| `force_thinking_loop=True` | 删除；`enabled:false` 两条路径一致 |
| `_is_llm_anomaly_kind` 字面量集合 | `anchor_for_kind(kind) == "llm"` |
| `_THINKING_LOOP_KINDS` | `is_stream_kind(kind)` |
| Monitor `FAULT_DOMAIN_LLM_THINKING_LOOP` fallback | `fault_domain_for_kind(anomaly.kind)` |

```mermaid
sequenceDiagram
  participant Hook as Platform_hook
  participant Hub as SessionHub
  participant D1 as Detector_A
  participant D2 as Detector_B
  participant Rec as build_recovery_actions
  participant L2 as applyActions

  Hook->>Hub: observe_signal
  Hub->>D1: observe
  D1-->>Hub: None
  Hub->>D2: observe
  D2-->>Hub: Anomaly
  Hub->>Rec: anomaly_plus_policy
  Rec-->>Hub: wire_actions
  Hub-->>L2: abort_notice_steer
```

### 6.4 Recovery / 文案

- 默认 `kind_overrides` = 各 `PLUGIN.recovery` 合并；宿主 `policy.kind_overrides` 仍可覆盖。
- [`robustness_prompt.py`](../../../../agent_ras/recovery/robustness_prompt.py) 只留**通用**模板；域文案来自插件 `messages.yaml`。
- 新域**不得**改 wire 类型集合。

### 6.5 Skill 路径解析

```mermaid
flowchart TB
  Call[skill_for_domain_role] --> Pkg["优先\nfault_domains/<id>/skills/<name>/"]
  Pkg -->|未找到| Legacy["兼容\ndetectors/skills 或 recovery/skills"]
```

---

## 7. 前后对比：扩展一个故障域

### 7.1 触点对比

```mermaid
flowchart LR
  subgraph old [改造前]
    O1[改8plus处框架代码]
  end
  subgraph new [改造后]
    N1[新建fault_domains/id]
    N2[写detector_PLUGIN]
    N3[可选skills_messages]
    N4[写设计文档]
  end
  old -->|框架一次性改造| new
```

| | 改造前 | 改造后 |
|---|--------|--------|
| 框架源码 | 必改多处 | **不改** |
| 配置 | `config.py` 加字段 | 域内 `config_model` |
| Kind | `AnomalyKind` 加成员 | `PLUGIN.kinds` |
| 注册 | `registry.py` 加一行 | 目录扫描 |
| 文案 | 改 `robustness_prompt` | 域 `messages.yaml` |
| Skill | 改 `FAULT_DOMAIN_SKILLS` | `PLUGIN.skills` |
| 文档 | features/*.md | 同左 + 域 README |

### 7.2 新增域操作清单（目标态）

1. 复制 `fault_domains/_template/` → `fault_domains/<id>/`。
2. 实现 `PLUGIN` + `build_detector` + `Detector`（按需 `AsyncRecoveryDetector`）。
3. 按需添加 `skills/*`、`messages.yaml`。
4. 域 `README.md`；复杂需求写 [`docs/agent-ras/designs/features/`](./) 并在 [Agent RAS README](../../README.md) 登记。
5. 单测 + 冒烟既有 thinking-loop / repeat 不回归。

**禁止清单**：改 `registry` / `config` 静态字段 / `models` 枚举 / `session_hub` / `monitor` / `robustness_prompt` 大字典；**也不新增**独立 manifest。

---

## 8. 内置域迁移

将现有能力迁为同形态插件，一次性删掉硬编码 builders：

| 现位置 | 目标插件包 |
|--------|------------|
| [`detectors/llm_thinking_loop.py`](../../../../agent_ras/detectors/llm_thinking_loop.py) + skills | `fault_domains/llm_thinking_loop/` |
| [`detectors/repeat_tool.py`](../../../../agent_ras/detectors/repeat_tool.py) | `fault_domains/repeat_tool/` |

`detectors/` 保留：`base.py`、`skill_verdicts.py`、可复用算法片段。  
宿主配置键 **`detectors.llm_thinking_loop` / `detectors.repeat_tool` 保持兼容**。

---

## 9. 兼容性与风险

| 面 | 结论 |
|----|------|
| Wire JSON | 不变 |
| 宿主配置键名 | 内置域键名不变 |
| `enabled:false` | SessionHub 与 factory **同语义**（去掉 force_thinking_loop；PR 显式声明） |
| Insight catalog / 能力 UI | 暂不自动发现；新域环内可用、看板文案可能滞后 |
| 仓外 pin `AnomalyKind` 枚举 | 破；调用方改用字符串 |

| 风险 | 缓解 |
|------|------|
| 插件 import 副作用 / 循环依赖 | Loader 只 import `detector` 模块；禁止插件 import Monitor/Hub |
| 恶意/损坏插件拖垮启动 | 单包校验失败 skip + error log；核心内置域加载失败则 fail-fast |
| 大 diff 冲击在途分支 | 分 commit：类型+Loader → SessionState 泛化 → 迁内置域 → template |
| kind 字符串拼写漂移 | Loader 校验 + 单测固定内置 kind 字面量 |

---

## 10. 实现分期与验证

### 10.1 分期

```mermaid
gantt
  title 故障域插件化分期
  dateFormat YYYY-MM-DD
  section 框架
  types与Loader           :a1, 2026-08-10, 5d
  kind字符串与动态配置     :a2, after a1, 4d
  SessionState与Monitor去硬编码 :a3, after a2, 4d
  section 迁移
  迁llm_thinking_loop与repeat_tool :b1, after a3, 5d
  _template与stub域证明   :b2, after b1, 3d
  section 验证
  单测与E2E冒烟           :c1, after b2, 3d
```

1. `FaultDomainPlugin` + `FaultDomainLoader` + 动态 kind/config。  
2. SessionState / Monitor / operations 查注册表。  
3. 迁两个内置域；删除 `DETECTOR_BUILDERS` 硬编码。  
4. `_template` + stub 域证明「只加目录」。  
5. 文档：本文件为真源；同步 [detectors.md](../modules/detectors.md) / [recovery.md](../modules/recovery.md) / [architecture.md](../architecture.md) 扩展指南。

### 10.2 验证计划

| 层级 | 内容 |
|------|------|
| 单测 | `test_fault_domain_loader.py`：发现、PLUGIN 校验、未知 kind、`enabled=false`、id 冲突 |
| 回归 | `cd agent_ras && python -m pytest tests -q` |
| E2E | `e2e_l3_thinking_dead_loop` / `e2e_l2_similar_clauses` / xiaoO inproc / `smoke_inproc` |
| 插件证明 | stub 域仅新增目录即可被 observe 路径装上（框架 git diff 无登记点改动） |

未跑 E2E 前不得在实现 PR 宣称完成。

---

## 11. 文档与清单同步

- [x] 本文件改写为自包含插件方案真源（v0.2）
- [ ] 落地实现后更新 [detectors.md](../modules/detectors.md)「扩展指南」
- [ ] 落地实现后更新 [recovery.md](../modules/recovery.md) / [monitor.md](../modules/monitor.md) / [architecture.md](../architecture.md)
- [ ] [docs/agent-ras/README.md](../../README.md) 特性表状态随实现推进
- [ ] [docs/design/README.md](../../../design/README.md) 需求清单描述与实现状态

---

## 附录 A：与旧版决策对照

| 旧决策 | 本版 |
|--------|------|
| D1 AnomalyKind 保留枚举 | **推翻** → 动态字符串 |
| D5 注册入口统一 | **保留并加强** → Loader 为唯一入口 |
| D6 配置留在 core/config 静态字段 | **推翻** → 域内 `config_model` |
| 不做 entry_points / 配置迁出 | **推翻** → 目录扫描 + `PLUGIN` |
| 独立 manifest.yaml（中间稿） | **不做** → `PLUGIN` 单源 |

## 附录 B：消息文件示意

```yaml
# fault_domains/<id>/messages.yaml
cn:
  steer_default: "检测到分析停滞，请收敛结论并开始执行。"
  notice_default: "可靠性：已中断冗长分析并注入纠正提示。"
en:
  steer_default: "Analysis appears stalled; converge and act."
  notice_default: "Reliability: interrupted overthinking and steered the agent."
```
