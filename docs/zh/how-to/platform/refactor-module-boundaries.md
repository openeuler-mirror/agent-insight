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

## TypeScript 接口怎样命名

| 对象 | 命名规则 | 本项目示例 |
| --- | --- | --- |
| 模块公开的业务服务 | 大驼峰。用“业务对象或职责 + Service”命名，让调用者能看出结果归属。 | `TraceTransferService.importTrace()` |
| 可替换的角色 | 大驼峰，用实现者的职责命名。转换外部格式用 Adapter，处理数据流用 Processor，提供并标识一个可装配实现用 Provider，负责存储读写用 Store。业务有明确名称时直接使用该名称。 | `ObservationAdapter.normalize()`、`Evaluator.evaluate()`、`StorageProvider.createStorage()` |
| 方法 | 小驼峰，以动作开头。查询一项用 get，查询集合用 list，能独立完成的业务操作使用业务动词。 | `getTraceDetail()`、`listTraces()`、`importTrace()`、`transaction()` |
| 输入输出 | 用业务名词命名，共用筛选条件用 Filter，含分页排序的查询用 Query，结果或持久回执用 Result 或 Receipt。 | `TraceFilter`、`TraceQuery`、`TraceImportResult` |
| 文件 | 小写单词用连字符连接。一个模块的相关服务和扩展接口可共用一个服务文件。 | `observation/trace-service.ts`、`storage/storage-interfaces/transactional.ts` |

`interface` 已表明声明类型，命名时省略 `I` 前缀及 `Interface` 后缀。新方法须先说明调用者和完成条件，再命名。数据库厂商名只用于相应的具体实现。

## 基础能力的调用边界

保存操作由业务模块登记，例如示例中的 `dataset.save`。调用方用 `storage.transactional.transaction('dataset.save', workspaceContext, input)` 一次提交。适配器验证身份、参数及操作名，存储宿主用同一连接执行整个操作。注册表中的操作名应绑定固定版本的操作契约。SQL、锁模式和授权凭据仅由可信宿主管理。ClickHouse 投影、制品及缓存有各自的接口。详细映射与双连接验收见主方案第 5.2 节。[可编译的调用与并发保护示例](../../../../test/UT/core/foundation/storage/storage-contract.types.ts)

业务模块通过 Logger 记录结构化事件。出现异常时，入口调用 ErrorReporter.capture 一次，按分类选 HTTP 状态并返回安全响应。页面显示稳定错误码和本次 error_id。服务端按 error_id、request_id 关联脱敏日志，生产默认 warn。文件日志由宿主配置轮转、总量和保存期限。

## 提交和评审核对

- 给每个新公开方法列出调用者、参数和成功条件。框架无关的类型用 TypeScript 定义，输入输出不能暴露 Next.js Request、ORM 客户端或本机路径。类型与实现放在表中规定的位置。
- 标明跨请求状态的拥有者和稳定编号。成功受理前持久化，重试沿用原幂等键。设备按消息编号去重，后台任务接管时核对已下发的工作并阻止失效执行方写回。
- 查询、导出和产物读取都受项目权限约束。客户端能看到的错误携带稳定错误码、error_id 和 request_id。日志能按这些标识定位并执行脱敏、分级和保留策略。
- 数据库写入使用 foundation 的统一事务入口。评审核对业务协调键、保护范围、加锁顺序、首次创建和重试；操作覆盖和双连接验收见[主方案第 5.2 节](../../../../design/platform/frontend-backend-separation/Agent-Insight前后端重构方案.md#52-数据库接入建表与迁移)。
- 单元验证放 `test/UT/<范围>/`；跨 HTTP、数据库、客户端的完整流程放平铺的 `test/ST/`。新增或变更公开行为时，同步对应契约、调用者和指南，列出实际执行过的验证。

首批接口声明见[观测服务](../../../../packages/core/observation/trace-service.ts)、[设备命令](../../../../packages/core/foundation/device-commands/device-command-service.ts)和[设备协议](../../../../packages/core/foundation/device-protocol/index.ts)。完整示例与扩展注册流程见[重构方案](../../../../design/platform/frontend-backend-separation/Agent-Insight前后端重构方案.md)。

新代码的引用应在新骨架内闭合。迁移时可查阅 [legacy/](../../../../legacy/)，并把依赖的契约、实现和测试迁入所属模块。

在仓库根目录使用 TypeScript 5.9.3 检查全部 core 接口、SDK 声明和契约调用示例：

```sh
tsc -p tsconfig.contracts.json
```
