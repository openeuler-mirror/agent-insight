# Runtime 参数配置设计

## 配置与草稿

客户端 YAML 维护原生默认模板、预设、可选执行 Schema 和交付绑定。平台接收 `configuration: { version: 2, defaults }`，缺省 defaults 按 `{}`；delivery、binding、schema 留在客户端，平台不解释这些业务格式规则。旧快照中的历史结构元数据只作为兼容数据读取。

所有 v2 目标使用通用编辑器，提供六种 JSON 类型、添加对象、对象子字段、数组元素、JSON 导入、差异预览、导出及个人模板。`initializeRuntimeDraft` 按 workerId/platform/agent 首次复制默认值，已有记录不覆盖，包括已删除所有字段的 `{}`。默认值刷新与个人草稿隔离；恢复默认显式重新复制当前模板。

草稿通过 `agentOptions: { version: 2, runtimeKey, definitionDigest, values }` 完整保存及下发，不按默认值字段筛选或重新合并。树形/JSON 双视图共享原始草稿，不自动拆层、扁平化、改名或将字符串解析为对象。平台仅做根对象、重复 key、有限数值、危险原型字段、256 KiB、32 层、20,000 节点等通用校验。

## 执行端

客户端从本机交付方式、绑定和执行 Schema 计算契约摘要，平台仅检查其不透明标识。默认值和预设修订独立，不使现有兼容快照失效。

`runtimeInvocationOptions` 校验最终值的业务 Schema，再生成应用实际支持的交付计划。CLI passthrough 将根 key 按原名交付，不逐字段维护映射；遇到不能消费的对象、数组、null、非法 key 或保留 flag 明确报错，不擅自拆层。JSON 文件/参数通道直接交付完整嵌套数据，临时文件逐次隔离并在成功、失败后清理。原生 YAML 等其他入口由客户端后续适配，平台不用修改编辑器格式。

MCTS 默认值保持七项 CLI 原名，但编辑、平台保存和下发均允许用户增加嵌套字段；能否执行由客户端判断。OpenCode 提供默认空对象的通用配置，当前使用 CLI 交付。

## 历史数据与模板

历史完整值和定义快照不改写，契约变化时仅确认原 JSON 用于新草稿，不猜测字段别名、层级或补入新默认值。确认更新新草稿的协议元数据，原实验保持原样。

个人模板使用既有 `UserSettings.settingsJson.runtimeParameterTemplates`，通过 `/api/eval/settings` 专用 section/action 追加不可变修订。应用模板只修改本次草稿，不修改客户端默认配置。

客户端更新代码需重新安装并重启；配置约每 30 秒重新读取、上报。安装覆盖运行时 YAML，保留 executor.local.yaml，定制模板在源码或配置仓维护。
