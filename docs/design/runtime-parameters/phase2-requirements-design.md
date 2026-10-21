# Runtime 参数配置设计

`services/executor/runtimes/<key>/runtime.yaml` 声明目标 platform/agent、默认值、预设、可选约束、原生配置结构和交付方式；共享包 `packages/agent-runtime` 提供浏览器可用的协议校验和 Node 加载器。执行命令仍由 Runtime 实现提供。平台不重新设计应用参数格式。

客户端加载 YAML，应用 `config/benchmark/executor.local.yaml` 的 `runtimes.<key>.defaults`，计算契约摘要及模板修订。能力上报包含不带执行绑定的描述。平台按客户端、platform、agent 选择描述，校验输入，冻结完整值和描述快照；执行端按本机定义再次校验。配置错误、未知结构和定义漂移显式失败。YAML 由 JSON schema 模式解析，不执行表达式。

## 通用配置协议 v2

Runtime 描述使用 `configuration: { version: 2, structure, defaults, schema?, delivery }`，执行绑定仅保留在可信 Runtime YAML 中。任务使用 `agentOptions: { version: 2, runtimeKey, definitionDigest, values }`。无配置时初始化默认值；显式提交时按完整替换处理，不再次补默认值。可选 schema 在创建和执行时均校验，不支持的关键字在加载时拒绝。

`structure: flat` 只允许根级字符串、数字和布尔值；`structure: nested` 仅用于执行端原生支持嵌套配置的应用，保留其对象、数组与 null。未声明结构时向导仅开放平铺能力，历史嵌套快照不变，但提交前需要执行端明确声明。平台共用一个 JSON 草稿状态，按声明限制树编辑的类型与层级；JSON 导入同样校验该声明，拒绝不匹配的结构，不自动展开、扁平化或重命名。导入解析成功后展示整体替换差异，用户应用后才更新本次实验；导出及最终预览使用同一解析结果。解析器检查重复 key、根对象、有限数值、结构深度和大小，并隔离危险原型字段。

MCTS 声明 `structure: flat`、`delivery: argv`、`binding: { mode: passthrough }`。key 与 CLI 原 long 选项名一致且仅省略统一 `--` 前缀，保留大小写、下划线和点号，不将点号解释成层级，按 `key/value → [--key, String(value)]` 交付，新增合法标量字段不要求默认值、Schema 属性或映射。布尔值是 `true`/`false` 字面量，不猜测开关；对象、数组、null 与保留调度字段拒绝执行。值以 `-` 开头时使用 `--key=value`，其余值通过独立 argv 字面量传递，空字符串保留。七项现有默认值、预设和约束使用相同的 CLI key，不引入业务分组层级。

已有 `binding.mappings` 模式保留给实际需要显式绑定的应用，用 JSON Pointer 与指定编码生成 argv，不允许静默丢弃未消费值。`json-file` 为每次调用创建临时 JSON 文件，通过执行端约定的路径入口交付并在退出后清理；`json-arg` 使用单个字面量 argv 参数交付完整对象。这些通道只在应用实际支持时使用，不能替代其原生 YAML 配置格式。OpenCode 当前保留空参数定义，后续按其实际结构及文件入口接入。

命令、工作目录、Case ID、模型和输出等平台控制字段不能被参数配置覆盖。MCTS 的 `mode/runtime/testbench/instance-id/split/output-dir` 等由上下文生成。业务 JSON 中同名数据字段仅在其实际交付契约允许时作为数据使用，任务其他控制位置仍执行原有禁止字段检查。

v2 契约摘要覆盖目标、结构、交付方式、Schema 约束及绑定；默认值、显示标签和预设修订独立于契约兼容版本。实验冻结完整值与描述，默认值更新不影响重跑。已有实验快照保持原样，不自动迁移；复用旧 MCTS camelCase 参数时展示固定历史名称转换的预览，确认后才生成新实验草稿。执行器不执行这层迁移，新参数无需追加兼容映射。旧客户端收到不支持的协议明确失败，不静默降级。

参数模板存于现有 `UserSettings.settingsJson.runtimeParameterTemplates`，通过 `/api/eval/settings` 的专用 section/action 读取与追加修订，避免参数编辑器读取或提交模型配置。模板包含 Runtime key、契约摘要、完整值、名称和修订号；选择模板仅覆盖当前草稿，保存产生新修订，其他设置保存应保留已有模板。

客户端安装包、npm 包和 standalone 包均包含共享加载器和 Runtime YAML。常驻客户端安装后从 `executor/runtimes/` 读取，源码使用 `services/executor/runtimes/`。新客户端约每 30 秒重读并上报 YAML；修改定义后等待上报或重启，刷新页面即可。执行代码升级需重新安装并重启；重新安装会覆盖安装目录的 Runtime YAML，定制声明应在源码或配置仓维护。
