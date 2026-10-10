# Trace 无上报超时：开发计划

Goal：修复 Issue #301 的所有框架十分钟无上报兜底及自动刷新。

1. 添加纯状态测试和真实 SQLite/API 回归，先在修复前运行并记录失败。
2. 在 prisma/schema.prisma、scripts/init_opengauss.py 增加 lastIngestedAt；data-service 和 consumer 保存活动时间，轻量列表返回该字段。
3. 提取 src/lib/observe/trace-lifecycle.ts，统一 data API 生命周期；旧静默规则不再改变执行状态。
4. trace/page.tsx 增加 timed_out 展示、筛选、列表和详情状态刷新；复用 StatusBadge warning。
5. 更新用户与开发指南、来源提交，以及指定 830 外部转测文档。
6. 运行专项、全量测试及类型检查；在隔离服务验证真实上报、十分钟边界和页面恢复，记录修复前后证据。
7. 审查差异，提交并推送原 #301 分支，更新 PR !403；不合并、不关闭 issue。
