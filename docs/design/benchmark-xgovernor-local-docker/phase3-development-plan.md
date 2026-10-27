# Benchmark xGovernor 本地 Docker 接入开发计划

本计划对应[需求分析](phase1-requirements-analysis.md)与[需求设计](phase2-requirements-design.md)，只说明实施顺序和验收要求；实施状态统一维护在[全仓需求清单](../README.md)。

## 1. 实施原则

- 先确定上游能力和公共合同，再切换 Pi/xiaoO + SWE-bench，避免把尚未验证的上游行为写成生产依赖。
- 新旧后端复用同一 Runner、上传和终态逻辑，迁移期间不复制第二套 Benchmark 执行器。
- 不修改 Prisma schema，不新增 Agent Insight API 路由；扩展已有 JSON、DTO 和 Schema。若实施发现确需改变此约束，先补充设计。
- 本轮不实现 OpenCode/xGovernor 集成或其他沙箱驱动，但必须用契约测试证明注册与替换边界。

## 2. 步骤一：固定上游依赖与验证接缝

1. 选择并记录 xGovernor commit、server/worker 构建、Pi/xiaoO 依赖版本及镜像兼容要求，安装包不得默认跟随移动的 `master`。
2. 在目标 Linux 环境验证 Docker、cgroup、认证、双监听配置、每 Case 独立 daemon、`/testbed`、bootstrap 和断网工具操作。
3. 分别验证 Pi 和 xiaoO 的 open、turn、事件终态、cancel、close、模型映射和完整原生 Trace 导出。
4. 记录需要的上游补充合同，尤其是 xiaoO 轨迹正文和取消后的资源状态。缺口未补齐的 Runtime 不上报 ready；不能仅因 Pi 跑通就宣布 xiaoO 已满足接入要求。

交付：固定版本清单、两种 Runtime 的脱敏协议/Trace 样本和能力检查依据。这些是实现验证材料，不包含真实凭据。

## 3. 步骤二：公共后端、协议与配置

1. 在 `services/executor/src/` 提取 `ExecutionBackend`、句柄、注册表和操作能力合同；实现 `LocalExecutionBackend` 包装现有组件。
2. 修改 Runner 的执行、收集、取消及恢复路径，消除对 `workspace.path`、`provider.rootDir` 和 xGovernor 资源结构的假定。
3. 扩展 `packages/project-config/` 与执行客户端配置，提供 Profile、绑定、驱动校验、公开描述和摘要；保留现有本地覆盖与未知字段报错规则。
4. 同步 `packages/benchmark-protocol/` 的 TypeScript、JSON Schema、校验器和摘要测试。新增可选执行描述，并用新后端能力门控；保持旧信封读取能力。
5. 在 `src/lib/benchmark/experiment-service.ts`、执行目标匹配与 orchestrator 中冻结、验证 Profile 和目标兼容关系；配置漂移不可静默重解析。

交付：本地后端回归通过，独立测试后端可驱动同一 Runner；带执行描述的任务不会被下发给旧客户端。

## 4. 步骤三：xGovernor 本地 Docker 后端

1. 在独立后端目录实现 daemon 管理、认证、会话 HTTP/SSE、Runtime 注册、工具操作和轨迹导出适配，不在常驻客户端或公共 Runner 堆叠平台分支。
2. 每 Run 独立管理状态目录、凭据、deployment、监听地址及资源预算；创建意图和执行句柄在副作用前后原子持久化。
3. 以 OCI 镜像准备合同承接 SWE-bench 官方实例环境，执行端复制本地缓存、SWR、代理及官方拉取逻辑，在自身 Benchmark 目录独立维护，不导入 Evaluator 实现或共用镜像模块；两端分别读取所在服务的镜像配置；固定本次本机镜像 ID、初始化 `/testbed`、恢复和核对 Git 基线。
4. 复用 Git Patch 算法和现有 Artifact 格式，补齐远端文件导出与大文件处理，确保上传重试不依赖容器存活。
5. 分别注册 Pi/xiaoO 的模型、Agent 参数和 Trace 转换，保留已有平台身份和精确 Session 关联。
6. 实现超时、取消、状态未知、正常退出、异常退出和 cleanup 待重试的资源闭环。

交付：两种 Runtime 分别完成单 Case 的准备、解题、完整 Trace、本地 Patch、关闭与清理，不调用上游批量判分脚本。

## 5. 步骤四：调度、能力、展示与分发

1. 将 Benchmark 与普通实验 readiness 分开；移除新链路对客户端原生 CLI Collector readiness 的错误依赖，同时保留对应原生实验探测。
2. 为 SWE-bench + Pi/xiaoO 生成环境规格和断网策略，不改变其他平台的任务，不把新能力加入 SWE-bench Manifest 的全局必需项。
3. 将准备、Agent、收集和清理期限贯通 progress、watchdog、指令 TTL 与恢复；心跳不延长绝对期限。
4. 确认页与详情展示冻结环境、实际隔离、资源和清理事实，复用既有组件与共享设计令牌，不增加任意沙箱配置表单。
5. 安装 bundle、npm、standalone 和已安装客户端升级均带齐新增后端、配置描述和 `xgovernor.cjs` 管理工具；用户在执行机显式运行 `update` 安装/升级，原客户端安装不静默下载或隐式安装 Docker。管理工具提供指定版本、检查后原子切换和回退，安装清单与实际制品摘要自动参与能力上报；在途 Case 固定原组件目录。
6. 切换前收敛在途任务；对旧版 Pi/xiaoO + SWE-bench 待执行任务显式报告需重新创建/迁移，不自动改变冻结执行方式。

交付：能力上报、创建、下发、执行、回传、平台评测、取消与复制实验形成一致的 Profile 生命周期。

## 6. 验收矩阵

| 类别 | 场景 | 通过条件 |
| --- | --- | --- |
| 后端可替换 | 同一公共 Runner 分别使用本地后端和独立测试后端 | 不依赖本机路径或解析 xGovernor 句柄，上传与终态语义一致 |
| Runtime 可扩展 | 测试夹具注册一个未来 OpenCode Runtime 映射 | 不修改公共 Runner、Docker 管理、Collector 或 Evaluator；不会因此开放真实 OpenCode 能力 |
| Profile 兼容 | 同一 Runtime 配不同能力的测试 Profile | 满足要求才执行；缺断网、资源或导出能力时明确拒绝 |
| 配置与摘要 | 未知字段、非法资源、Profile 变化、旧客户端 | 配置错误或漂移明确失败，不降级到宿主机执行 |
| 数据边界 | 对下发信封和 Agent 容器检查隐藏数据 | 不含 gold patch、test patch、测试名单或私有 evaluation payload |
| 工作区 | 错误镜像、架构不符、HEAD 不符、初始化不完整 | 提交任务说明前失败并回收本次资源 |
| Patch | 新增/删除、二进制文件、保留路径、空文件、大小边界 | 与既有 `git-patch/v1` 一致，导出无截断，摘要准确 |
| Trace | Pi/xiaoO 分别包含消息、工具参数/结果、用量与终态 | 来源可核对，Run/Session 精确映射，摘要不冒充正文 |
| 并发隔离 | 同一实例的两个 Run 同时执行 | daemon、工作树、Trace、Artifact 和清理互不串线 |
| 取消 | 准备、open、运行、收集、上传各阶段停止 | 只终止自身任务，未确认资源不记为清理成功 |
| 重启恢复 | 创建意图、会话打开、submit intent、上传和清理窗口崩溃 | 能对账或清理；已提交任务不自动重跑，未知状态不重复提交 |
| 重试与断流 | SSE 断流、请求结果未知、上传/complete 失败 | 不重复执行 Agent，持久化数据可重传 |
| 时间与预算 | 长镜像准备、持续心跳、清理失败 | 准备不占用 Agent 期限；绝对期限有效，待清理资源继续占预算 |
| 目标范围回归 | 原生 OpenCode、MCTS、普通实验、Skill 实验 | 原有执行选择、Trace 与评测行为不变 |
| 平台评测 | 上传 Patch 后进入既有 Evaluator | 使用独立官方评测环境，结果和 Evidence 按原合同归一化 |

真实验收至少包含 Pi 和 xiaoO 各一条完整 SWE-bench Case、两个并发 Run、一次运行中取消和一次资源创建后的客户端重启。完整 Case 的“通过”表示链路与权威评测运行正确，不要求模型必然解决该题；Resolved 可以为 false。

## 7. 检查与指南更新

- 开发过程中运行与本阶段变更对应的协议、Runner、配置、调度、Artifact、Trace 和恢复测试；实施交付前执行 `npm run test`。
- 真实 Docker/模型 Smoke 与单元测试分别记录环境、固定版本、输入、期望和结果；单元测试通过不等于部署验收完成。
- UI 验证按仓库约定先取得用户启动 dev 的确认，再使用 `bash scripts/develop_start.sh` 验证 golden path 和至少一个边界场景；未执行时明确记录“未在浏览器中验证”。
- 同步 `docs/user-guide/evaluation/experiments.md`、`docs/developer-guide/benchmark/service-deployment-guide.md`、`docs/developer-guide/benchmark/benchmark-integration-development-guide.md` 及实际受影响的 Trace 指南。
- 不在开发者指南 INDEX 写实现流水；只在页面导航或术语变化时调整它。实施进度和验收状态维护于全仓需求清单。
