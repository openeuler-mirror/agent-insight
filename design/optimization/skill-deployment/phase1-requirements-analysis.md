# 优化后 Skill 下发：需求分析

## 目标

在「评测结果 → 故障诊断 → Skill 优化 → 复测 → 发布」之后，允许用户把正式发布的 Skill 版本下发到产生来源 Trace 的用户端。OpenCode、Pi、xiaoO 必须回到原执行位置；JiuwenSwarm 下发到该实例的用户全局 Skill 目录。下发前备份客户端当前内容并记录版本，下发后校验实际内容与版本；用户恢复历史版本时重新下发对应正式版本，部署失败时才自动恢复部署前快照。

## 当前基础

- `SkillVersion` 保存整数版本、可选语义版本及完整文件，`SkillOptimizationRecord` 保存复测与发布结果。
- 诊断生成候选发布前已有 `retest_passed` 门禁。
- `ReliabilityClient` / `ReliabilityCommand` 已提供客户端身份、能力与受控命令状态。
- OpenCode 已有隔离 workspace Skill 写入；Pi Collector 运行时可取得 `cwd`、`filePath`；JiuwenSwarm 已有 Skill Sync、原子替换和 `.archive/versions`。

## 关键缺口

- Trace 只保存框架、客户端和 Skill 名称/版本，未冻结实际来源引用与内容哈希。
- 控制面没有 Skill 预检、下发、制品领取或部署状态协议。
- 用户端没有统一的当前版本账本、持久备份和安装后验证。
- Pi、xiaoO、JiuwenSwarm 的普通 Trace 与常驻客户端身份关联不完整。
- JiuwenSwarm 导入覆盖会保留旧 `current_version`，不能代表新下发版本。

## 范围

首期支持一个正式 Skill 版本下发到一个来源执行客户端：

1. 优化发布页或版本历史选择正式版本。
2. 预检目标客户端、来源、当前版本、内容哈希及备份计划。
3. 二次确认后下发受控制品引用。
4. 客户端旁路暂存、持久备份、原子替换、刷新和校验。
5. 服务端记录从版本、到版本、哈希、备份引用、阶段和错误。
6. 历史版本使用同一接口重新下发；不修改服务端 `Skill.activeVersion`。

首期不支持同名多版本同时激活、未发布候选、浏览器提供任意路径、找不到原来源时自动改投全局目录、覆盖 JiuwenSwarm 内置 Skill。客户端离线或来源漂移时不自动延迟重放，重新上线后必须重新预检。

## 框架目标规则

| 框架 | 模式 | 目标 |
| --- | --- | --- |
| OpenCode | `execution_origin` | 原项目 `.opencode/skills/<name>` |
| Pi | `execution_origin` | Trace 时实际加载 Skill 的根目录 |
| xiaoO | `execution_origin` | Trace 时实际加载 Skill 的根目录 |
| JiuwenSwarm | `framework_global` | `${JIUWENSWARM_DATA_DIR:-~/.jiuwenswarm}/agent/workspace/skills/<name>` |

## 版本语义

- `skillVersion`：Agent Insight 正式整数版本，作为下发、展示和历史选择的主版本。
- `semanticVersion`：可选框架/企业语义版本，不替代整数版本。
- `contentHash`：内容身份；同版本不同哈希必须阻止。
- 客户端同名 Skill 仅一个激活版本，历史内容保存在不参与框架扫描的备份区。
- 旧内容无版本账本时标记 `legacy`，仍以哈希备份。

## 验收标准

- 下发目标由可信 Trace 和客户端能力解析，浏览器不能指定路径、URL、命令或文件内容。
- OpenCode、Pi、xiaoO 缺少来源引用时明确阻止；JiuwenSwarm 由客户端解析实际数据目录。
- 下发前后两次校验当前版本和哈希，路径漂移或并发修改返回冲突。
- 备份标识被替换版本、哈希、时间和部署 ID；多个历史备份互不覆盖。
- 安装、刷新或验证失败时恢复部署前快照并报告 `failed_restored`。
- 正常恢复旧版本从服务端正式 `SkillVersion` 重新下发，不把本地备份当作业务版本源。
- 同一幂等键不重复安装；相同版本/哈希可安全返回已安装。
- 不跨用户、客户端或框架复用来源引用；所有阶段可审计。
