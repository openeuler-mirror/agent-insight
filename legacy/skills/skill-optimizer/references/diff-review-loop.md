# Diff Review Loop 与快照版本

本文件解释优化完成后的人工 Review 机制与版本快照结构。


## 快照目录结构

每次优化在外层工作区目录下生成 `snapshots/`（与内层 Skill 目录同级）：
```
{skill-name}-optimized-{timestamp}/       ← 外层工作区
├── {skill-name}/                          ← 内层纯 Skill 目录
│   ├── SKILL.md
│   ├── scripts/
│   └── references/
├── snapshots/                             ← 版本快照（位于外层工作区）
│   ├── v0/                  ← 初始基线版本
│   │   ├── SKILL.md
│   │   └── meta.json          ← {"reason": "Initial version", "source": "auto", ...}
│   ├── v1/                  ← 优化后的新基线
│   │   ├── SKILL.md
│   │   └── meta.json
│   └── v1.1/                ← 用户反馈后的候选版本 (minor 递增)
│       ├── SKILL.md
│       └── meta.json
└── OPTIMIZATION_REPORT.md                 ← 最新优化报告
```

> **注意**：`snapshots/` 位于外层工作区而非内层 Skill 目录中，这样加载 Skill 到 `.opencode/skills/` 时不会包含快照等过程产物。

`meta.json` 字段：`reason`（本次优化原因）、`source`（本次优化的来源，user/auto）、`mode`（模式，static/dynamic/feedback/hybrid）、`base_version`（基于哪个版本）、`created_at`（时间戳）。

## 交互工作流程

1. **首次优化**：生成新版本（如 `v1`）并自动显示 Diff 页面。
2. **Review & Action**：Diff 页面三个快捷按钮（一键复制提示词并提示用户粘贴回聊天窗口）：
   - ✅ **Accept**：复制“我接受本次优化，作为新稳定基线。”的指令文本。接受结果，作为新稳定基线。
   - ✏️ **Revise**：复制“我对当前版本有反馈，请按如下修改”的指令前缀文本。提供修改意见继续优化（生成 `v1.1`）。
   - ↩️ **Revert**：复制“请回滚到指定旧版本并从那里重新开始”的强指令文本。回滚到上一稳定版重新开始。
3. **循环迭代**：每次完成 Diff Review 后，统一使用以下三选一提示来决定是否继续推进：
“满意就继续下一步 / 不满意先改 / 到此为止”。

实现入口： scripts/snapshot_manager.py

## 使用示例

```
用户: 帮我优化这个skill
系统: [执行优化，生成 v1 并显示 diff]
      ✅ 优化完成！请在 Diff 页面选择 Accept 或 Revise。

用户: [点击 Revise] 描述太长了，请精简一下
系统: [基于 v1 继续修改，生成 v1.1 并显示 diff]
      ✅ 已精简描述！

用户: [点击 Accept]
系统: [接受 v1.1 并提升为 v2]
      ✅ 成功接受优化，已保存为新基线版本: v2
```

## Diff 查看器功能

- 优化完成后会生成并打开一个 HTML Diff 页面，用于对比历史版本与当前候选版本。自动打开浏览器，支持 Side-by-side / Unified 视图
- Diff 页面提供版本选择器（base → current）与统计信息，便于快速定位改动范围。
- 词级高亮 + 语法高亮，文件状态标记（MODIFIED / ADDED / REMOVED）
- 内置代码行数统计
- 集成 Accept / Revise / Revert 提示词生成

实现入口： scripts/diff_viewer.py
