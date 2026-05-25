# A/B 测试任务 Skill 强绑定方案

## 背景

A/B 测试任务当前只在 `configJson.skillId` / `configJson.versionBId` 中弱引用 Skill 与实验版本。历史上允许多个任务引用同一个 Skill 版本，且存在没有明确 Skill 绑定的冗余任务，导致与 Skills 分析按 `Skill + version` 定位评测的模型不一致。

## 目标

- 每个用户下，一个 `Skill 名称 + B 实验版本号` 最多绑定一个 A/B 测试任务。
- A/B 任务创建时必须绑定 Skill 与 B 实验版本，后续不可改绑到其他 Skill 或 B 版本。
- Skills 分析切换 `Skill + version` 时，A/B 面板自动切到对应任务；不存在则创建默认任务。
- 历史数据按 `configJson.skillId + configJson.versionBId` 回填；同用户同 Skill 同版本只保留最新任务。

## 方案

1. `GrayscaleTask` 增加 `skillId`、`skillName`、`skillVersion`、`skillVersionId` 字段，`@@unique([user, skillName, skillVersion])` 作为最终兜底。
2. `POST /api/debug/grayscale-tasks` 必须接收 `skillId` 与 `versionBId`，解析出 Skill 名称与版本号后创建任务；重复时返回 409 和现有任务。
3. `PATCH /api/debug/grayscale-tasks/[taskId]` 禁止把 `configJson.skillId` / `configJson.versionBId` 改成其他绑定，只允许配置继续引用任务绑定的 Skill + B 版本。
4. `POST /api/debug/grayscale-tasks/[taskId]` 启动/评测前校验 `configJson.skillId` 与 `configJson.versionBId` 和任务绑定一致，防止旧前端或手写请求绕过。
5. 前端在 Skills 分析内嵌模式按父级 Skill + version 自动选择/创建任务；已有任务的 Skill/B 版本下拉禁用，避免误以为能换绑。
6. 清理脚本 `scripts/cleanup_grayscale_skill_binding.ts`：
   - 回填 `skillId`、`skillName`、`skillVersion`、`skillVersionId`。
   - 删除无法解析 Skill 或 B 实验版本的任务。
   - 对同用户同 Skill 同版本的重复任务，只保留 `createdAt` 最新的一条。
   - 建唯一索引。

## 风险与取舍

- 删除重复历史任务会丢弃旧 A/B 运行结果；这是为了满足“同 Skill + 版本只能有一个任务”的新约束。保留策略选最新任务，符合当前页面默认展示最新任务的使用习惯。
- SQLite 本地库需要执行清理脚本完成表结构和历史数据迁移；Prisma schema 同步表达目标结构。
