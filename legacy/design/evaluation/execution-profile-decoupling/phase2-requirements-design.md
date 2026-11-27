# 执行 Profile 解耦设计

公共协议只负责身份、摘要、Agent/模型、策略和执行环境结构；后端执行实际支持校验。新增 workspace 环境与 local Profile（client-default 网络、无沙箱），保留原 OCI 格式与旧 xGovernor 描述摘要。无 Profile 的旧本地路径保持兼容。

统一 config 接受显式 backend/options；旧 flat Profile 仅兼容为 xGovernor。后端专属纯配置/描述放在 project-config 子模块，公共旧导出以兼容入口委托。执行端按 backend 分发探测，xGovernor 的安装、文件身份和凭据检查独立，本地探测复用原生 Runtime 的 Trace 能力。

规范化配置保留 xGovernor 运行器所用 flat 字段，内部增加 backend 标识；专属字段不进入公共 Profile。未配置新格式时保留原 SWE-bench 默认绑定；显式新格式不隐式注入 xGovernor。未知后端/未知字段拒绝。

沿用执行后端 registry 生命周期。local Profile 在入口校验冻结摘要、绑定、Agent/模型和实际本地策略；xGovernor 仅接受其 OCI/deny/Docker 组合。准备服务按 binding.backend 分派；公共流程不把本地执行当成沙箱。

客户端只消费探测后的公开目标和 Trace 可用性，不读取 Worker 等专属字段。平台根据能力与绑定匹配；同一 Benchmark/平台多个绑定在配置阶段拒绝，避免无选择界面时按数组第一项执行。来自外部客户端的重复候选明确报错，不自动降级。

默认绑定仅作为旧客户端缺少上报时的兼容约束；新客户端显式上报 bindings。旧冻结 Profile 字段与 digest 不改写。资源限制只在对应后端能执行时声明，界面不再固定显示断网或 Docker 资源。

验证包括旧摘要兼容、未知配置拒绝、local 不触发 Docker/xGovernor 探测、跨 Profile 故障隔离、实际 Runner 使用 local、冻结变更拒绝、多绑定拒绝、安装分发与全仓回归。无真实模型调用；浏览器验证须按仓库约束另行确认。
