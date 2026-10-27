# 跨 Session 协作：需求设计

## 身份解析与接口

复用现有事件存储和鉴权，不新增 Prisma 模型。普通 reported 事件只需调用 `POST /api/ingest/collaborations/events`，首次出现的端点自动成为协作节点。服务端按当前用户内 `Session.taskId` / `Execution.taskId` / `Execution.agentSessionId` 精确解析；候选对应不同 taskId 时判歧义，不按名称或时间猜测。

`POST /api/ingest/collaborations/sessions` 继续支持不可覆盖的逻辑 Session 到 Trace taskId 绑定。普通接入无须预绑定；已有绑定和 Goal Plus collector 的 main/worker 显式绑定继续有效。未知事件时钟不进行时间推定；明确时钟声明仍作为可选证据，不新增必填字段。

`GET /api/observe/collaborations` 提供用户隔离分页列表；`GET /api/observe/collaborations/:id` 返回分页上报关系与只读自动关系。同一详情处理器的 `native?traceTaskId=...` 模式用于不含上报事件的旧 Trace。自动边只来自原始工具的明确目标编号，类型/FIFO 兜底不算证据；仅有明确记录位置和目标对应时合并 reported/trace 来源。

`/observe/collaborations` 与 `/observe/collaborations/:id` 展示节点、带说明连线和事件列表。节点可打开经鉴权的原文，边显示说明、内容、定位状态及候选。循环、自联系和重复联系均可浏览。使用共享样式令牌，分页刷新重算，不永久保存推定位置。查询限额只限制一次解析，关系仍可分页读取，并明确提示未完成；不构造虚假 Span、执行数据或完成状态。

## 现有 Trace 读取投影

普通 reported 投影复用图查询的精确 taskId 映射，不要求 sessions 预绑定。成员可读时，链路列表保留一个合并入口，详情包含全部成员。`display-tree.ts` 分别构建各 Session 原有树，再组合：有 `fromLocator` 且位置唯一的关系挂到对应工具下，candidate 标“候选步骤”，confirmed/time_ordered 保留原证据状态；没有定位或无法确定唯一调用父级的成员并列展示。循环、自联系、多父级和回传事件保留在协作图，不强制转为 Trace 父子关系。展示顺序使用关系 observedAt，缺失时使用接收时间，不推断实际串行执行。

普通成员缺失、无权限、空正文、重复 Execution、已有原生子记录或 Langfuse 专用树时，相关组件保留原始列表，避免隐藏不可展示的 Trace。相同子 Trace 正文只展示一次；跨协作的父级冲突仍不强制合并。列表过滤发生在数据库分页和计数前；指定 taskId 及“全部 / 子 Agent”范围保留原记录入口。

Goal Plus `gp.<hash>` 的 `main → worker:*` reported 路径继续独立处理。已有 worker binding 的已声明成员进入 `hiddenChildren`，尚未合并的成员同时进入 `pendingChildren`，避免 main binding 晚到时把 worker 当成独立主记录。隐藏不等于合并：只有主端与当前 worker 唯一解析且正文就绪时才生成详情 links；其他 pending worker 不阻塞该成员。历史 Goal Plus semantic 路径保留持久化端点关联回退，不能用它掩盖普通 reported 的当前身份歧义。

详情的 structure/full/interactions 保留原 Session 标识、源索引和正文版本；懒加载使用源 Session 与索引，刷新版本变化时丢弃旧正文。`source=raw` 绕过展示投影，不改原始 Session/Execution 父子关系、评估口径或其他框架接入。

投影最多扫描 200 个协作组、2000 条关系、200 个 Session、32 MiB 正文，超过限制保留原列表并记录 warning。单组解析仍受 2000 条事件、200 个会话、累计 100000 个调用等限制，不使用不完整数据推定顺序。已有原生子树与 Goal Plus 专用投影路径保留。

## 运行日志与自动升级

复用公共 logger 的 collaboration scope，记录请求 ID、操作、HTTP 结果、定位状态、错误代码及原因；响应头回传请求 ID。日志不含采集凭据、传递正文或命令。两个既有启动脚本将 stdout/stderr 写入仓库根 server.log；db_push 和 generate 在启动前执行，沿用该自动升级链路，不关闭破坏性变更保护。本轮不新增表或迁移；既有 SQLite 升级回归与 OpenGauss 实库验收是独立验证层。

## 验收范围

覆盖无需绑定、无 Trace/晚到、身份歧义、唯一步骤定位、无定位、循环、多级及列表分页只保留合并入口；另覆盖 Goal Plus 主 binding 晚到、worker 先到、逐 worker 就绪、pending 列表隐藏、历史 semantic 已关联状态和原文懒加载。验收目标与实际覆盖分开记录，实际结果见[开发计划中的验证记录](phase3-plan.md)。
