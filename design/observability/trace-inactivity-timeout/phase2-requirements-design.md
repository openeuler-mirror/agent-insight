# Trace 无上报超时：需求设计

## 数据与计时

Execution 新增可空 lastIngestedAt，记录服务端处理采集更新的时间；统一采集保存路径写入，普通读取、打标和评测不能刷新计时。spool consumer 的同批 fast/evaluated 保存复用同一活动时间。子 Agent 沿用对应采集批次的时间。

已有记录没有该字段时使用已有记录时间作为兼容依据，不迁移或删除原始 Trace。字段只增不改，SQLite 用 prisma db push，OpenGauss 初始化脚本同步新增可空列。

## 状态

有可靠结束时间时按明确结束状态显示；否则 now - lastIngestedAt >= 600000 时返回 timed_out，reason=inactivity-timeout；阈值前为 running。该规则不检查 framework 和回答是否为空。超时是读时状态，不写入 endTime，收到新采集更新后自动重新计时。

GET /api/observe/data 的轻量、完整、分页、状态筛选与排序使用相同判定。返回 trace_last_received_at；超时仍返回空 trace_completed_at。旧 60 秒静默不再决定生命周期。

列表和详情每 5 秒刷新当前可见记录的状态；详情同时刷新 Session。超时后继续轮询以便接收恢复上报，明确结束后停止详情自动刷新。状态使用共享 warning 令牌，提供中英文标签和超时筛选。

## 验证

覆盖所有已知框架和未知框架、无回答、599999/600000 ms、持续上报、超时后恢复、明确成功/失败优先、light/full 查询与筛选一致、重启后时间保留，以及前端无需重进页面的状态变化。
