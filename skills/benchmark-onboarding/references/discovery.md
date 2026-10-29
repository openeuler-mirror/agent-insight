# 来源与能力查询

## 从用户入口定位目标

用户给出 Agent Insight 项目地址和 Benchmark 来源。项目地址可以是 Git 仓库 URL 或已存在的本地根目录；平台 Web/API 地址是另一项部署连接信息。先定位匹配的工作副本，核对 remote、分支、commit、未提交改动和仓库协作约束。`init` 只检查已有副本，不自动 clone、fetch、切分支或改 Git 配置。

本地路径必须对应工作副本根目录。远端地址按主机和仓库路径匹配，HTTP(S)/SSH 和末尾 `.git` 可归一；不根据同名目录推定匹配。地址有凭据时改用不含凭据的仓库地址和现有认证机制。无法定位、访问受限或多个副本无从选择时，给出具体缺口。

先读 [benchmark-protocol.md](benchmark-protocol.md) 与[来源清单](benchmark-protocol.sources.json)，理解稳定契约；按 [usage.md](usage.md) 运行只读协议核对。清单中的路径是发现起点，不是固定的项目布局要求。在目标根目录按以下线索发现文档和代码，路径移动时继续按标题或符号检索：

```bash
git -C "$TARGET_REPO" remote -v
git -C "$TARGET_REPO" status --short
git -C "$TARGET_REPO" rev-parse HEAD
rg --files "$TARGET_REPO/docs" "$TARGET_REPO/packages" "$TARGET_REPO/services" "$TARGET_REPO/benchmarks"
rg -n 'Benchmark 接入|AbstractBenchmarkAdapter|validateTaskEnvelope|createBenchmarkExecutor' "$TARGET_REPO/docs" "$TARGET_REPO/src" "$TARGET_REPO/packages" "$TARGET_REPO/services"
```

只读查询结果可以自动用于下一步。需要获取远端代码、调整分支或引入公共能力时，按目标仓库约束和用户已授权范围处理。

## 对照协议快照与目标版本

协议说明保存稳定的架构、目录、接口、数据边界和结果契约；当前可用组件及环境不属于快照。`protocol-check.cjs` 比较实际工作副本文件内容，不只比较 HEAD 或线协议字符串，也不加载执行目标仓库的代码。

- `match`：清单覆盖的文件摘要一致；继续查询其他相关扩展、组件实现和部署，不能直接宣布兼容或就绪。
- `review_required`：有文件变化或缺失；阅读目标版本、检索移动的路径，区分文档变化、需要适配的模板/桥接及公共能力缺口。仅有文档变化不自动要求平台改造。
- `error`：包内快照/模板损坏、路径异常或 Git 查询失败；先修复输入或安装包，不能当作目标协议不兼容。

用 [protocol-review.json](../assets/templates/protocol-review.json) 记录快照版本、目标 HEAD、实际协议路径和摘要、差异依据与处置。维护者从明确 commit 更新快照及来源清单；普通接入 Agent 不就地改写已安装 Skill。目标版本不同但已有能力足够时，在本次接入包适配方法签名、字段和资源；需要调整通用桥接时作为单独维护变更处理。所有所读目标文件及处置记录进入基线输入，不能只冻结核对报告而遗漏实际源码。

## 分析官方实现

追踪任务链时同时按 [live-validation.md](live-validation.md) 发现各阶段实际 API/CLI、身份、异步状态、幂等和取消/清理合同，形成 L1/L2/L3 测试矩阵；环境准备接受态、就绪态与 Agent/Evaluator 终态分别识别。接口列表取自目标版本，包内不维护另一份固定入口支持表。

记录权威数据、代码和 Harness 的固定 revision，数据 split/subset、样本数量、Case ID、授权条件及文件摘要。区分官方发布、Hugging Face 镜像、第三方整理和实际导入数据；名称一致不代表版本一致。

追踪 Loader 到安装事务、查询接口、数据模型与存储配置，确定实际数据库/索引、文件/对象、版本和 Case 映射、内容指纹算法、重复导入及失败恢复合同。按 [数据集安装验收](live-validation.md#数据集安装验收必检) 制定内容、持久化、二者一致性和导入恢复的断言；不从本机默认目录推断部署数据位置。

沿函数调用追踪以下过程，每个结论引用代码位置和版本：

1. 任务创建、公开输入和隐藏材料装载。
2. 被测 Agent 的运行方式、工具/网络可见性、反馈时机与预算。
3. 提交生成：回答、文件、完整环境、进程事件或状态句柄。
4. Verifier 对提交的读取、错误分类、原生指标与聚合。
5. 超时、取消、恢复和资源释放。

固定文本或文件能独立判分时，验证不重新执行 Agent 的重评；依赖环境状态时，明确快照或恢复的充分条件。反馈参与执行时保持其时序和可见范围，不能把最终判分可独立误解成可以移除中间反馈。隐藏测试、答案和官方参考解不进入被测 Agent 输入或公开目录。

开发 Agent 为分析资料联网，不等于被测 Agent 获得搜索权限。网络策略必须由实际执行后端验证；目录分离和独立进程本身不是隔离证明。

## 从协议发现平台能力

以所给项目版本的接入规范为权威，在完成协议差异核对后，查询类型、校验器、注册实现和测试，再查询部署状态。包内协议提供必须遵守的关系，具体 Provider、Agent、Git 来源、Collector、后端和镜像必须现场发现，不能从快照示例推定支持：

查询部署状态前，核对平台地址、当前登录账号/租户及其客户端和数据集可见范围。用户指定账号时使用该身份；页面仍在加载、账号不匹配或权限不足时，不能将空列表判为能力缺失。保存不含凭据的身份与目标证据，再按所选 Benchmark 查询执行目标。在线客户端、可选执行目标和实际环境检查通过是不同结论，分别记录。

新接入包发布还需定位平台与 Evaluator 的部署源码版本、目录和更新方式；已有执行客户端不代表本地新代码已部署。先查询项目已有部署说明和配置，缺少实际部署位置时只补问这一项，不要求用户重复提供已发现的执行机。

| 要求 | 发现线索 | 需要的证据 |
|---|---|---|
| Case 与任务 | Manifest、任务类型、Adapter 基类及协议校验器 | 字段是否可表达且被真实校验路径接受 |
| 工作区和运行 | 执行器装配、Provider、Runtime、Backend | 初始化、运行、取消与清理实现 |
| Submission | Collector 注册、Artifact 契约和摘要校验 | 实际收集的内容足以重现官方评分 |
| Evaluator | Catalog 校验、Evaluator 注册和 Entrypoint | 所需依赖、隔离与原生输出支持 |
| 就绪状态 | 执行目标接口、客户端能力上报、环境准备入口 | 本次目标机器、Agent 和 Case 可运行 |
| 验证入口 | 目标仓库测试、Doctor/Smoke、端到端接口 | 是否真实执行，是否覆盖本次新增接入 |

结论使用“可复用 / 部署待准备 / 公共能力缺口 / 待验证”。组件存在不等于部署就绪；准备能力存在不等于本次环境已准备。不能在 Manifest 写一个新能力名来代替实现。

确认单放在包外，参考 `assets/templates/integration-plan.md.tmpl`。把所读协议、官方源码/评分配置、数据锁和冻结提交纳入验收计划的输入摘要；不在 Skill 里维护可用 Agent、Git 来源或 Collector 的固定列表。
