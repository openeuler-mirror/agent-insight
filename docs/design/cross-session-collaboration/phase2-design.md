# 跨 Session 协作：需求设计

复用现有事件存储和鉴权。服务端按当前用户内 Session.taskId / Execution.taskId / Execution.agentSessionId 的精确匹配解析，候选对应不同 taskId 时判歧义；不按名称或时间猜测。历史 sessions 接口仅兼容既有绑定，不再是新接入前置条件。未知事件时钟不进行时间推定；历史明确时钟映射仍作为可选证据，不新增必填字段。

GET /api/observe/collaborations 提供用户隔离分页列表；GET /api/observe/collaborations/:id 返回分页上报关系与只读自动解析关系。增加同一查询处理器的 native?traceTaskId=... 模式，用于不含上报事件的旧 Trace。只从原始工具的明确目标编号建立自动边，类型/FIFO 兜底不算证据；有明确记录位置对应才合并 reported/trace 来源。

/observe/collaborations 与 /observe/collaborations/:id 展示可点击节点/带说明连线和完整事件列表，节点可打开经鉴权的原文，边显示说明、内容、定位状态及候选。循环、自联系和重复联系均可浏览。采用共享样式令牌。分页刷新重算，不永久保存推定位置。移除上一轮自定义关系在旧 Trace 列表/树中的合并入口，保留上游 Goal Plus 专用功能。

复用已有表，不新增 Prisma 模型；日志沿用 collaboration scope 和 server.log。查询限额只限制一次解析，关系分页仍可访问，明确提示未完成。不构造虚假 Span、执行数据或完成状态。
