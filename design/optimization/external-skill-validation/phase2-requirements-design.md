# Skill 待验证版本发布：需求设计

## 总体流程

优化仍生成候选并执行现有发布前质量门禁。门禁通过后，`SkillOptimizationRecord` 进入可发布状态；会话卡片允许用户确认发布。发布事务创建 `SkillVersion` 和版本验证记录，但保留原 `Skill.activeVersion`。用户通过既有版本下载接口取得 ZIP，在外部环境验证后调用按 Skill `name` 暴露的验证接口登记结果；通过后再调用受验证状态保护的激活接口。

## 状态划分

候选生命周期继续由 `SkillOptimizationRecord.status` 管理：`optimizing → pending_retest → published`。其中 `pending_retest` 在界面解释为“前置质量通过，可发布”，不再表示必须先由平台完成行为复测。

正式版本验证生命周期独立保存：

- `pending`：待外部验证。
- `passed`：用户确认外部验证通过，允许激活。
- `failed`：用户确认外部验证失败，不允许激活。
- `not_required`：历史或非外部发布流程，保持兼容。

激活状态不新增字段，仍以 `Skill.activeVersion === SkillVersion.version` 判断。

## 数据模型

`SkillVersion` 增加当前验证摘要：

- `verificationStatus String @default("not_required")`
- `verificationMode String?`，首期外部发布写 `external`
- `verifiedAt DateTime?`
- `verifiedBy String?`
- `verificationNote String?`

当前优化记录通过 `publishedVersion` 解析正式版本和验证状态。首期只保留当前验证结果；若后续要求上传多轮证据，再拆独立事件表，不在本次引入无消费方的历史模型。

## API

### 发布待验证版本

复用 `POST /api/skill-workbench/skills/:name/optimizations/:recordId/publish`，请求增加：

```json
{
  "confirmed": true,
  "verificationMode": "external",
  "activate": false
}
```

服务端只接受 `external + activate=false` 的新流程。发布事务创建 `SkillVersion(verificationStatus=pending)`，更新优化记录为 `published`，但不更新 `Skill.activeVersion`。响应返回版本、当前激活版本和验证状态。

### 登记外部验证结果

新增 `POST /api/skills/by-name/:name/versions/:version/verification`：

```json
{
  "result": "passed",
  "note": "可选的验证说明"
}
```

接口按当前用户和 Skill `name` 鉴权，只允许 `passed | failed`，限制说明长度，并返回更新后的版本验证摘要。重复提交相同结果幂等；改变结果视为一次显式更正并更新时间与操作者。

### 激活

新增按名称路由 `POST /api/skills/by-name/:name/versions/:version/activate`，只允许 `verificationStatus in (passed, not_required)`。旧 ID 路由保留兼容，但统一调用同一服务并执行相同门禁，避免绕过。

版本 ZIP 继续复用 `GET /api/skills/:id/versions/:version/download`，会话卡片从发布响应或记录投影取得 Skill ID 与版本后触发下载。

## 服务层

在 `publish-service` 中将优化候选发布改为“创建但不激活”，并把文件写盘、版本行、优化记录与工作台会话更新保持在现有一致性边界内。新增版本验证服务负责：

1. 按用户、Skill 名称和版本解析权限。
2. 更新验证摘要。
3. 校验激活门禁并原子更新 `activeVersion`。
4. 返回会话卡片需要的轻量状态。

文件目录创建发生在数据库事务之前，数据库失败时仍沿用现有清理策略的约束；实现需避免把并发冲突留下的目录误认成成功版本。

## 会话卡片

`OptimizationResultCard` 是主入口：

- `pending_retest/retest_*` 已结束且前置质量有效：显示“发布待验证 vN”；平台行为验证正在运行时等待结束，避免状态竞争。
- `published + pending`：显示“vN 已发布 · 待外部验证”，提供“下载 vN ZIP”“验证通过”“验证失败”。
- `published + passed`：显示“外部验证通过”，若未激活提供“激活 vN”。
- `published + failed`：显示“外部验证未通过”，提供“继续优化”和下载复查。
- 已激活：显示“vN 已验证并激活”。

确认弹窗必须明确“发布后不会替换当前激活版本”。优化记录页保留详情和审计展示，但不作为本需求的主操作入口。

## 安全与并发

- 新 API 对外使用 Skill `name`，DB `id` 只用于内部和既有下载兼容。
- 发布重新校验候选哈希、静态评估、基线最新版本和版本目录冲突。
- 验证与激活均校验版本归属；激活前重新读取最新验证状态。
- 发布、验证和激活操作均记录现有 usage event；说明不接受 HTML 或文件路径语义，只作为纯文本展示。
