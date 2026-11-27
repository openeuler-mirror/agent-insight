# 前后端重构的模块接口与评审规则

适用于新骨架和迁入骨架的功能。设计接口时，先写出调用者要完成的操作、输入、成功结果、失败或重试的影响，再确定归属。一次调用应完成一个调用者可以独立使用的结果。例如导入 Trace 包含鉴权、校验和保存；从 Trace 生成用例草稿后还有用户确认，所以生成草稿和保存用例是两个方法。

| 开发者要定义什么 | 必须放在哪里 | 评审时核对什么 |
| --- | --- | --- |
| 页面调用的 HTTP 方法、路径、请求和响应 | `apps/server/rest-interfaces/` 下所属领域的 OpenAPI | Web 通过 REST 访问业务。项目授权由服务再次检查，身份来自可信入口。 |
| HTTP 请求处理 | `apps/server/src/controllers/` | 将请求转成服务输入，将结果或异常转成统一响应。事务、评测调度和业务步骤在 core 中完成。 |
| 其他模块调用的业务方法 | 能力提供方的 `packages/core/<模块>/*-service.ts` | 调用方只引用该公开契约。已有的服务能力直接复用，避免跨模块导入 application、私有适配器或重复声明同一接口。 |
| 业务流程及内部规则 | 同模块 `application/` | 实现完整用例，组织业务校验、授权、读写和事务。可复用的内部规则按业务含义命名，如设备命令的 delivery-state-rules。 |
| 客户可以替换的实现 | 所属业务模块的服务文件定义扩展接口；独立实现放 `extensions/<模块>/<类型>/<key>/`，并在该类型的 registry.json 声明 | 接入一个同契约扩展只增加实现包及登记项。模块内部的凭据验证、数据转换等宿主适配按需放在自己的 adapters。 |
| 启用哪些实现 | `apps/server/src/bootstrap/` 或 `apps/client/src/bootstrap/` | 初始化时按配置装配。core 依赖接口，具体扩展包、HTTP、容器和数据库驱动留在宿主或对应基础设施实现。 |
| 设备消息与传输 | foundation/device-protocol 定义消息、确认、处理结果；foundation/device-commands 定义平台发给指定设备的命令服务 | 客户端 communication 负责连接、重连和本地持久收发，handlers 分派，capabilities 串联流程。评测作业与发给设备的单条命令分别跟踪。 |
| 公共能力 | foundation/common 管调用上下文、产物引用、分页、错误和日志；foundation/storage 管存储契约与驱动；foundation/agent-runtime 管平台内置 Agent | foundation 只依赖自身或下层基础设施。通用存储不得出现实验、Trace 等业务流程，core 通过对应存储契约读写。 |

## 提交和评审核对

- 给每个新公开方法列出调用者、参数和成功条件。框架无关的类型用 TypeScript 定义，输入输出不能暴露 Next.js Request、ORM 客户端或本机路径。类型与实现放在表中规定的位置。
- 标明跨请求状态的拥有者和稳定编号。成功受理前持久化，重试沿用原幂等键。设备按消息编号去重，后台任务接管时核对已下发的工作并阻止失效执行方写回。
- 查询、导出和产物读取都受项目权限约束。客户端能看到的错误携带稳定错误码、error_id 和 request_id。日志能按这些标识定位并执行脱敏、分级和保留策略。
- 单元验证放 `test/UT/<范围>/`；跨 HTTP、数据库、客户端的完整流程放平铺的 `test/ST/`。新增或变更公开行为时，同步对应契约、调用者和指南，列出实际执行过的验证。

参考实现的接口声明见[观测服务](../../../../packages/core/observation/trace-service.ts)、[设备命令](../../../../packages/core/foundation/device-commands/device-command-service.ts)和[设备协议](../../../../packages/core/foundation/device-protocol/index.ts)。完整示例与扩展注册流程见[重构方案](../../../../design/platform/frontend-backend-separation/Agent-Insight前后端重构方案.md)。
