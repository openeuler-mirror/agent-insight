# 专项诊断器测试用例集 — 故障模式总览

> 更新日期：2026-08-07

---

## 统一用例表

| 目录                     | 用例文件                                    | 故障说明                                                                                                                     | 诊断器           |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| state-regression       | case-01-baseline-state-regression.json  | 修复折扣逻辑时同一区域反复改写（Math.round→*100/100→toFixed→guard→Math.round），累计 5 次修改最终回到基线（净变化≈0）；同一测试范围 PASS→FAIL→PASS→FAIL→PASS 多次回退 | 状态回退诊断器       |
| state-regression       | case-02-test-regression.json            | 修 divide 除零时，同一测试范围经历 FAIL→PASS→FAIL→PASS 往返，终值回到基线（PASS）                                                                | 状态回退诊断器       |
| state-regression       | case-03-legit-trial-deliver.json        | 试 level_map 方案通过后改 whitelist 失败，回退 level_map 交付成功，净变化为正（合理试错，不应误报）                                                       | 状态回退诊断器（边界）   |
| state-regression       | case-04-task-state-regression.json      | 子任务 t1 状态 completed→in_progress→completed→in_progress→completed→closed，验收打回重做 3 轮                                        | 状态回退诊断器       |
| state-regression       | case-05-todo-state-regression.json      | todo 清单 A/B/C 三项各自在勾选后因前置未满足回退 in_progress 再重做                                                                           | 状态回退诊断器       |
| state-regression       | case-06-config-env-regression.json      | LOG_LEVEL info→debug→info、FEATURE_FLAG on→off→on，环境变量调整后恢复原值                                                             | 状态回退诊断器       |
| state-regression       | case-07-db-write-rollback.json          | orders 表两轮 INSERT/ROLLBACK（update_task 仅记录 action 序列，中间计数不在轨迹中），最终 count 回到 100                                          | 状态回退诊断器       |
| retry-storm            | case-01-auth-fail-storm.json            | call_api 连续 8 次相同错误指纹 `[401] invalid api key`，无退避无策略改变，始终失败                                                              | 重试风暴诊断器       |
| retry-storm            | case-02-rate-limit-storm.json           | upload 连续 9 次 `[429] rate limited`，仅 file 参数微变，无指数退避，未完成                                                                 | 重试风暴诊断器       |
| retry-storm            | case-03-recovered-after-retries.json    | create_user 连续 5 次 `[400] invalid email`（同指纹），修正参数后成功，恢复浪费成本                                                             | 重试风暴诊断器       |
| retry-storm            | case-04-normal-few-retries.json         | 仅 1 次 `[503]` 后即成功恢复，属合理少量重试（不应报）                                                                                        | 重试风暴诊断器（边界）   |
| retry-storm            | case-05-backoff-strategy-recovery.json  | `[401]` 后 refresh_token 换新 token 重试成功，有退避与策略改变（不应报）                                                                      | 重试风暴诊断器（边界）   |
| dependency-deadlock    | case-01-circular-dependency.json        | t1 blocked_by t2、t2 blocked_by t1 形成循环依赖；claim 被拒（"task t1 blocked by [t2]"），两任务永久阻塞                                     | 依赖死锁诊断器       |
| dependency-deadlock    | case-02-stuck-on-prerequisite.json      | t1 认领后长期停留 in_progress 无完成事件，t2 blocked_by t1 始终未获执行机会                                                                   | 依赖死锁诊断器       |
| dependency-deadlock    | case-03-task-starvation.json            | t1/t2 被 worker 反复 claim 占用，低优先级 t3 始终 pending 无人认领，任务饥饿                                                                  | 依赖死锁诊断器       |
| dependency-deadlock    | case-04-agent-handover-loop.json        | executor send_message(wait_for:reviewer.approval)、reviewer send_message(wait_for:executor.result) 互相等待形成闭环               | 依赖死锁诊断器       |
| dependency-deadlock    | case-05-no-deadlock-fine.json           | 无环依赖链 t1→t2→t3 顺序 claim 全部完成，无任何等待环（不应报）                                                                                 | 依赖死锁诊断器（边界）   |
| oscillation            | case-01-strategy-flip-flop.json         | 递归↔迭代方案 update_task(approach) 切换 4 次，每轮有理由但始终未落定                                                                         | 振荡诊断器         |
| oscillation            | case-02-agent-conclusion-void.json      | 两评审在共享任务 r1 的 verdict 字段 PASS↔REJECT 互相否定 4 次（集体振荡）                                                                      | 振荡诊断器         |
| oscillation            | case-03-file-modify-revert.json         | 端口 8080↔3000 去重后切换 3 次往返，最终保持 8080                                                                                       | 振荡诊断器         |
| oscillation            | case-04-plan-state-toggle.json          | test-first↔impl-first 计划切换 3 次，始终未落定                                                                                     | 振荡诊断器         |
| oscillation            | case-05-no-oscillation-settled.json     | 一次对比内存/持久化即选定交付，无两态往返（不应报）                                                                                               | 振荡诊断器（边界）     |
| resource-runaway       | case-01-context-inflation.json          | 上下文膨胀：reporter 50 轮 usage.input 从 5000 单调增至 64000（约 12.8x，结论轮 80000），无 compaction                                        | 资源失控诊断器       |
| resource-runaway       | case-02-call-explosion.json             | 尾部 25% 节点聚集 85% 调用（12 轮重复相似 view_task docX 共 50 次），前部仅 9 次低耗                                                             | 资源失控诊断器       |
| resource-runaway       | case-03-latency-runaway.json            | 延迟恶化：durationMs 从 1s 单调增至 130s（130x），尾部连续慢调用                                                                             | 资源失控诊断器       |
| resource-runaway       | case-04-artifact-growth.json            | 中间材料膨胀：outputLength 从 300 增至 900k（3000x），逐层翻倍                                                                            | 资源失控诊断器       |
| resource-runaway       | case-05-recovered-after-compaction.json | input 升 22000 → isCompaction=true → 回落 3000~3800 保持，正常恢复（不应报）                                                            | 资源失控诊断器（边界）   |
| evidence-source        | case-01-unsupported-conclusion.json     | reporter 无任何 read 工具调用，直接报「Node 版本 20」，结论无证据支持                                                                           | 证据来源诊断器       |
| evidence-source        | case-02-stale-evidence-overwritten.json | read 得端口 8080，leader 改配置 9090，reporter 仍报 8080——结论使用被覆盖的旧证据                                                              | 证据来源诊断器       |
| evidence-source        | case-03-conflicting-evidence.json       | reporter-a 读 config.json 得 feature_flag=on、reporter-b 读同文件得 off，leader 只取其一未处理冲突                                         | 证据来源诊断器       |
| evidence-source        | case-04-wrong-source.json               | 连接串数据实际来自 db.js（source:db.js），leader 结论却归因 package.json，来源错配                                                             | 证据来源诊断器       |
| evidence-source        | case-05-supported-conclusion.json       | read config.js 得端口 9090，结论与最新证据一致（不应报）                                                                                   | 证据来源诊断器（边界）   |
| quality-gap            | case-01-missing-format-constraint.json  | 要求返回 JSON `{"temp":number}`，reporter 返回自然语言「今天温度 25 度」，格式缺失（35分）                                                         | 质量差距诊断器       |
| quality-gap            | case-02-missing-requirement.json        | 要求列出依赖+许可证，reporter 只报依赖名 lodash 漏许可证类型（40分）                                                                             | 质量差距诊断器       |
| quality-gap            | case-03-off-path.json                   | 应查询数据库核验，reporter 却凭经验直接报「约 1000」，从未执行 db_query（30分）                                                                     | 质量差距诊断器       |
| quality-gap            | case-04-silent-degrade.json             | 要求总结三大要点+改进建议，reporter 只总结两点且无建议，全程无报错（25分）                                                                              | 质量差距诊断器       |
| quality-gap            | case-05-high-quality.json               | 按路径 read 数据库返回数字 1000，高质量交付（95分，不应报）                                                                                     | 质量差距诊断器（边界）   |
| task-handover-contract | case-01-missing-constraint.json         | 意图 requirements 含 region=华东/year=2024，交接 create_task constraints={} 为空，缺口式遗漏约束（missing_constraint）                       | 任务交接契约诊断器     |
| task-handover-contract | case-02-scope-error.json                | 交接 scope=[src/moduleA.js]，子智能体 edit 了 moduleA/B/C 三文件，集合超出（scope_overflow）                                               | 任务交接契约诊断器     |
| task-handover-contract | case-03-stale-context.json              | 意图要求 v2 API，交接 api_version=v1（已废弃），子智能体调 v1 得 404（stale_api_version）                                                     | 任务交接契约诊断器     |
| task-handover-contract | case-04-result-mismatch.json            | 交接 return_format=json，子智能体返回自然语言「大概三百万」，格式违反（format_violation）                                                           | 任务交接契约诊断器     |
| task-handover-contract | case-05-correct-handover.json           | 意图==交接==返回（constraints+json 全满足，返回 {"total":120000}），契约完整（不应报）                                                           | 任务交接契约诊断器（边界） |
| task-outcome-integrity | case-01-unmet-requirement.json          | 要求实现+测试+文档三义务，reporter 只实现 add 漏 README 文档，义务缺失（60分，unmet_requirement）                                                   | 完成条件核验诊断器     |
| task-outcome-integrity | case-02-unsupported-claim.json          | edit 修改后从未运行 test 即宣称「修复完成」，无验证证据（40分，unsupported_completion_claim）                                                      | 完成条件核验诊断器     |
| task-outcome-integrity | case-03-stale-evidence.json             | 第二次 edit 后未重新 test，沿用旧 PASS 结果宣称通过（45分，stale_evidence，时间序）                                                               | 完成条件核验诊断器     |
| task-outcome-integrity | case-04-success-no-effect.json          | run_command(exit 0) 成功但 read 显示文件内容未变，命令成功≠效果（35分，unsupported_completion_claim）                                          | 完成条件核验诊断器     |
| task-outcome-integrity | case-05-all-met-verified.json           | 实现+测试+文档+最新 test(PASS) 全满足，证据最新（95分，不应报）                                                                                 | 完成条件核验诊断器（边界） |

---

## 汇总统计

| 诊断器       | 目录                     | 用例数 | 正向  | 负向/边界 |
| --------- | ---------------------- | --- | --- | ----- |
| 状态回退诊断器   | state-regression       | 7   | 6   | 1     |
| 重试风暴诊断器   | retry-storm            | 5   | 3   | 2     |
| 依赖死锁诊断器   | dependency-deadlock    | 5   | 4   | 1     |
| 振荡诊断器     | oscillation            | 5   | 4   | 1     |
| 资源失控诊断器   | resource-runaway       | 5   | 4   | 1     |
| 证据来源诊断器   | evidence-source        | 5   | 4   | 1     |
| 质量差距诊断器   | quality-gap            | 5   | 4   | 1     |
| 任务交接契约诊断器 | task-handover-contract | 5   | 4   | 1     |
| 完成条件核验诊断器 | task-outcome-integrity | 5   | 4   | 1     |

**总计**：47 个用例，**37 正向** + **10 负向/边界**（诊断器列标注「（边界）」）。均以 `/tmp/jiuwenswarm-example-trace.json` 为模板的 jiuwenswarm 多智能体方言。
