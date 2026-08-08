# 平台用量统计（usage-analytics）

管理员专用的功能采用度统计。设计原则一句话：**统计绝不进入业务热路径，绝不改变业务结果，随时可关。**

关联需求文档：`User Requirements/phase{1,2,3}-*.md`。

## 模块结构

```
src/lib/usage-analytics/
  catalog.ts        # 唯一真源：16 个可统计功能 × 各自的有效使用定义
  types.ts          # UsageEvent / UsageStorage / API 响应类型
  config.ts         # 开关与保护常量（队列上限、flush 阈值等）
  date.ts           # Asia/Shanghai dateKey 生成与日期区间
  auth.ts           # fail-closed 管理员判定与权限闸
  collector.ts      # recordUsageEvent：业务侧唯一入口
  queue.ts          # 有界内存队列 + 后台批量 flush + 保留清理
  storage.ts        # UsageStorage 的 SQLite / OpenGauss / 内存实现
  queries.ts        # 只读日聚合的汇总与详情查询
  client-events.ts  # 客户端语义行为上报
  use-usage-access.ts # 前端入口可见性 hook
```

## 数据流

```
业务 API 成功分支 ─ recordUsageEvent() ─┐
客户端 Promise 成功 ─ POST /api/usage/events ─┤
                                              ↓
                                   有界队列（5000，满即丢）
                                   50ms 或 200 条触发 flush
                                              ↓ 短事务
                    PlatformUsageEvent(365天) + PlatformUsageDaily(永久)
                                              ↓
                              管理 API 只读聚合表（"全部"也不扫原始事件）
```

## 新增一个统计事件

1. 在 [`catalog.ts`](../../src/lib/usage-analytics/catalog.ts) 对应功能的 `uses` 里加一条，声明 `key` / `label` / `source` / `countWhen`。
2. 在业务成功分支调用：

```ts
recordUsageEvent({
  user: username,
  featureKey: 'skill',
  eventKey: 'skill.download',
  route: request.nextUrl.pathname,
});
```

客户端语义行为改用 `reportClientUsage(featureKey, eventKey)`；一次点击可能触发多个请求的场景用 `createOnceReporter()` 去重。

3. 测试会自动校验：event key 全局唯一、`featureKey`/`eventKey` 匹配注册表、调用点没有 `await`。

## 硬性约束（改代码前先读）

- **不得 `await recordUsageEvent()`**，也不得 `.then()`。它同步返回 `void`，异常全部内部吞掉。测试 [`instrumentation.test.ts`](../../test/usage-analytics/instrumentation.test.ts) 会扫描源码强制这一点。
- **不得把统计写入并进业务事务** —— 统计失败绝不能回滚业务。
- **不得在业务成功响应前同步写统计库**。
- **管理 API 只能 `resolveUser(request)`**，禁止传 `explicitUser`，否则 `?user=admin` 就能提权。
- **不得把事件字段加到 `Execution`** 这类高频大表。
- 用量表**不与业务表建外键**，不影响现有查询计划。

## 队列语义

- 容量 5000，满了丢统计事件而不是反压业务。
- flush 延迟 **50ms**（不是设计文档写的 1000ms）：1s 会留出"刚点完操作就重启 → 事件丢失"
  的窗口，而信号处理函数不能 await，退出钩子抢不过进程退出。50ms 仍能合并突发点击。
- 落库失败最多重入队一次，第二次失败即丢弃，日志每分钟限频一次。
- `flush()` 在有在途 flush 时会直接 return。**调用方若要轮询排空，必须先 `await queue.settle()`**，否则会陷入不推进的忙等（基准脚本曾因此 100% CPU 空转）。

## 双数据库

`UsageStorage` 有三个实现：`PrismaUsageStorage`（SQLite）、`OpenGaussUsageStorage`、`InMemoryUsageStorage`（测试）。三者跑同一份 [`storage-contract.test.ts`](../../test/usage-analytics/storage-contract.test.ts)。

SQLite 侧因为 `createMany(skipDuplicates)` 不返回实际插入行，先按 `eventId` 过滤已存在项再累加聚合；OpenGauss 侧直接用 `ON CONFLICT DO NOTHING RETURNING`。两者都保证**重放同一批不重复计数**。

未配置 `DB_HOST` 测试环境时，OpenGauss 契约测试显式 skip，不得标成通过。

## 性能基准

```bash
npx tsx scripts/benchmark_usage_analytics.ts --users=1000 --days=365 --events=1000000
```

阈值：入队 p95 < 0.2ms；7/30/90 天查询 p95 < 300ms；全部 < 800ms；业务 API p95 增幅 ≤ 2%。任一不达标就保持 `AGENT_INSIGHT_USAGE_ENABLED=0`。
