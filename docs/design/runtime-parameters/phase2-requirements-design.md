# Runtime 参数配置设计

`services/executor/runtimes/<key>/runtime.yaml` 声明目标 platform/agent、参数组、字段类型/约束/默认值、预设和 argv 绑定；共享包 `packages/agent-runtime` 提供浏览器可用的协议校验和 Node 加载器。执行命令仍由 Runtime 实现提供。

客户端加载 YAML，应用 `config/benchmark/executor.local.yaml` 的 `runtimes.<key>.defaults`，对完整定义计算 SHA-256。能力上报包含不带 CLI 绑定的描述和摘要。平台按客户端、platform、agent 选择描述，校验输入、补全默认值，冻结生效值和描述快照。任务只携带 `agentOptions: { runtimeKey, definitionDigest, values }`。执行端按本机定义再次检查摘要和字段，使用 argv 数组生成参数，拒绝未知字段和定义漂移。

通用字段支持 integer/number/string/boolean/enum；布尔开关显式声明 true/false 的 flag 行为。配置中的参数不能覆盖 Runtime 管理的模型、agent、工作区、输出、协议等启动参数。配置错误显式失败。YAML 由 JSON schema 模式解析，不支持执行表达式。

实验详情使用冻结描述展示；复用新配置时保留值和摘要，若当前描述不同则提示重新确认。旧格式参数不展示/复用，执行和新实验创建直接拒绝。

客户端安装包、npm 包和 standalone 包均包含共享加载器和 Runtime YAML；常驻客户端将定义安装到 `executor/runtimes/`，源码与 npm/standalone 使用 `services/executor/runtimes/`。新增普通字段无需改前端；特殊启动流程仍需 Runtime 适配代码。客户端重启后重新加载并上报配置。
