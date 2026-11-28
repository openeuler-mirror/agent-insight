# 开发与验证

1. 增加 021 三后端迁移及历史批次关系回填，验证旧库备份升级。
2. 接入 OTLP 和 collector source 两类采集登记，实施有限领取、依赖失败、状态查询与受控恢复。
3. 配置 64 HTTP 槽、观测计数和 Web 繁忙错误传递。
4. 增加针对重试耗尽、跨用户独立推进、混合 Trace 批次、租约失效、恢复和 HTTP 容量的回归用例。
5. 更新中英文存储操作与参考指南，记录实际通过和未验证的边界。

相关测试覆盖 observation、collector source、trace service、migration、project storage 配置及 Web Core transport。全量测试按用户要求省略。


## 验证结果

- Python 采集、恢复、迁移、CLI、关系库适配定向组：241 项，147 通过、94 项可选数据库环境测试跳过。
- Python HTTP 容量、Trace 服务和启动脚本定向组：48 项通过。实际 loopback HTTP 验证 64 个同时占槽、第 65 个明确拒绝、槽位释放后恢复，以及异常/断连释放。
- TypeScript Web 传递、GET 重试、配置、原有重试回归组：87 项通过；schema 021 Web 就绪检查：3 项通过。
- 旧 SQLite 020 隔离副本经 migrate-sqlite 备份升级，核验原始记录、计划和 attempts 保留、再次迁移及两次服务初始化；无 outbox 映射时迁移整体回滚。
- PostgreSQL/openGauss/ClickHouse 真实服务未在本次联调；事实写入失败用可控测试替身验证。Docker 启动脚本使用测试替身验证，未运行真实 Compose。
- 按用户要求未运行全量测试、未启动 dev、未在浏览器验证。事务写锁及数据库连接池策略未调整。
