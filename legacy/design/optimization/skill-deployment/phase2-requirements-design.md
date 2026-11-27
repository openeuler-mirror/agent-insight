# 优化后 Skill 下发：需求设计

## 总体架构

前端只提交 Skill 名称、来源执行和正式版本选择。服务端完成版本门禁、来源归属、制品构建和部署状态编排，通过现有可靠客户端控制面发送引用型命令；用户端按框架适配器解析本地目标、备份、替换、刷新并验证。

## 数据模型

新增 `ExecutionSkillOrigin`：`executionSkillId`、`clientId`、`platform`、`targetMode`、`originRef`、可选展示路径、观测版本/哈希、定位器版本和时间。`originRef` 是客户端本地注册表的不可透明引用，绝对路径不进入命令 payload。

新增 `SkillDeployment`：用户、Skill 名称、目标正式版本/语义版本/制品哈希、可选优化记录、来源执行、客户端、平台、目标模式、来源引用、部署前版本/哈希、备份引用、方向、状态、命令、错误、幂等键及时间。

新增 `SkillDeploymentEvent`：部署阶段、状态和受限详情，提供审计与进度恢复；不保存 Skill 正文、密钥或下载 URL。

状态为 `created → preflighting → ready → downloading → backing_up → applying → reloading → verifying → succeeded`，失败为 `failed`；已改动客户端文件后失败并成功恢复为 `failed_restored`。

## API

| 接口 | 作用 |
| --- | --- |
| `POST /api/skills/:name/deployments/preview` | 校验正式版本和来源，向客户端做只读预检 |
| `POST /api/skills/:name/deployments` | 二次确认后创建幂等部署 |
| `GET /api/skills/:name/deployments/:deploymentId` | 查询阶段、结果、版本与错误 |
| `GET /api/reliability/client/v1/skill-artifacts/:artifactRef` | 目标客户端认证领取短期、设备绑定的制品 |

版本来源为 `{type:'optimization', optimizationRecordId}` 或 `{type:'published_version', skillVersion}`。优化来源只能解析到记录的 `publishedVersion`；历史来源只能选择所属用户已有正式版本。下发旧版本不修改 `Skill.activeVersion`。

## 客户端协议

能力增加 `skillDeployment`：协议版本、目标模式、备份、恢复、刷新与验证支持情况。命令增加 `PRECHECK_SKILL_DEPLOYMENT` 和 `DEPLOY_SKILL_ARTIFACT`。

部署 payload 只包含 `deploymentId`、`artifactRef`、Skill 身份、目标版本/哈希、预期当前版本/哈希及 `targetMode/originRef`。命令校验显式禁止路径、URL、文件、Shell、参数和 cwd。

客户端结果包含安装版本/哈希、有效来源、是否需要重启，以及备份前版本/哈希/引用。客户端只允许操作注册来源或框架适配器解析出的允许根目录。

## 制品与本地账本

制品由设备鉴权接口返回 `manifest` 与确定性排序的文本 `files` 映射。客户端在写盘前重新计算内容哈希。构建时复用 Skill 快照路径、文件数和总大小约束，拒绝绝对路径、空段、`.`、`..`、反斜杠、NUL、符号链接和特殊文件；`contentHash` 只覆盖业务 payload。

当前版本账本包含 `schemaVersion`、`skillName`、`skillVersion`、`semanticVersion`、`contentHash`、`deploymentId`、安装时间和管理来源。物理位置由适配器确定，不修改 `SKILL.md`。

备份名为 `v<version>__<UTC>__<hash-prefix>__<deploymentId>`；未知旧版本使用 `legacy`。备份保存 `manifest.json` 与完整内容。首期不自动清理备份。

## 适配器

统一接口提供 `resolveTarget`、`preflight`、`backup`、`apply`、`writeVersionState`、`reload`、`verify` 和 `restore`。

- OpenCode：目标为来源 workspace 的 `.opencode/skills/<name>`，账本与备份放在 `.opencode/.agent-insight/`。
- Pi：以 Collector 已知的 `skill.filePath/baseDir` 注册来源，禁止根据 cwd 猜测另一个目录。
- xiaoO：先补 Skill 加载事件；无法取得实际路径时只上报不可部署原因。
- JiuwenSwarm：由客户端解析用户全局目录，使用与其他框架一致的旁路备份和原子替换；结果明确返回 `restartRequired`，首期不声称热刷新。项目源码目录不作为用户 Skill 目标。

## 并发、离线与安全

- preview 结果带当前版本和哈希，apply 前客户端再次比较；不一致返回 `VERSION_CONFLICT`。
- 相同用户和幂等键唯一；相同目标版本/哈希已安装可返回成功，同版本不同哈希必须失败。
- 客户端离线、命令过期或重连不自动执行旧部署；用户重试生成新预检。
- 制品引用绑定部署、客户端和过期时间；有效期内允许同一设备为网络恢复重复领取，预期版本/哈希与幂等安装防止重复写入。服务端不在命令中提供自由 URL。
- 目录解析使用 realpath、根目录 allowlist 和同文件系统暂存；拒绝目标/父目录符号链接逃逸。

## 交互

复测发布成功及版本历史均提供「下发此版本」。预检弹窗展示框架、客户端、目标显示路径、当前/目标版本、升级或降级方向、备份说明和阻断项。部署进度展示预检、下载、备份、安装、刷新、验证；失败区分未改动、已自动恢复和需要人工处理。
