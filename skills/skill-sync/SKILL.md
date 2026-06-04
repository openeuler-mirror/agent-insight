---
name: skill-sync
description: 当用户明确提出要将某个 skill 上传（Push）到 Insight 平台上，或者从平台上拉取（Pull）某个 skill 时调用的专用工具集合。
---

# Skill Sync (Skill 同步组件)

这是一个**专用基础技能（Infrastructure Skill）**。它**只用于**向 Witty-Skill-Insight 服务端上传 Skill 或者从服务端拉取 Skill 到本地存储库。

## ⚠️ 核心要求：交互确认机制 (Interactive Confirmation)

**非常重要**：在执行任何上传或拉取动作之前，**必须**向用户发起明确的询问并提供分支选项。

### 1. 上传 (Push) 之前的交互示例
如果用户要求你上传技能，请先锁定本地技能文件夹路径，然后必须询问：
```
Question: "已准备好将本地技能 [技能路径] 上传至 Witty Insight 平台。是否确认执行上传？"
Options: "1. 确认上传", "2. 取消"
```
*只有用户选择了 1，才执行 `scripts/push.js`。*

### 2. 拉取 (Pull) 之前的交互示例
如果用户要求你拉取技能，必须询问可能发生的覆盖风险：
```
Question: "准备从 Witty Insight 平台拉取技能 [技能名称]。这可能会覆盖本地同名文件。是否继续？"
Options: "1. 确认覆盖并拉取", "2. 取消并退出"
```
*只有用户选择了 1，才执行 `scripts/pull.js`。*

---

## 🛠️ 脚本使用指南

本技能的脚本纯基于 Node.js 编写（需 Node.js 18+ 环境，因为依赖了原生的 fetch）。

### 1. 上传 (Push) 本地技能
用于将本地开发好的，或通过 skill-generator、skill-optimizer 生成的技能文件夹整体打包上传。

**执行命令:**
```bash
node scripts/push.js <目标技能文件夹路径>
```
*示例: `node scripts/push.js ../skill-generator`*

**脚本特性:**
- 工具会自动读取 `~/.agent-insight/.env` 下的 `AGENT_INSIGHT_HOST` 和 `AGENT_INSIGHT_API_KEY`。
- 如果检测到没有配置，或者配置文件不存在，脚本会报错并提示。
- 【处置缺失配置】：如果你发现脚本报错没有配置，请询问用户：
  `"检测到您尚未配置 Agent Insight 平台的连接信息。是否需要我为您生成/配置 ~/.agent-insight/.env，还是您放弃本次操作？"`

### 2. 拉取 (Pull) 平台技能
用于从平台上下载某个技能并在本地解压安装。

**执行命令:**
```bash
node scripts/pull.js <要拉取的技能名称> [可选: 本地解压目标路径]
```
*示例: `node scripts/pull.js git-automation ./skills/`*

**脚本特性:**
- 如果不指定目标路径，默认将解压至当前工作目录的同名文件夹内。