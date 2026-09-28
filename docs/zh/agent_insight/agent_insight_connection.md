# 登录和接入 Agent

本章介绍首次登录及通过 AcTrail 上报 Agent 运行数据。830 版本的 **安装指导** 页面提供 AcTrail 的 Linux 接入命令。

## 首次登录

1. 打开管理员提供的平台地址，例如 `http://<服务器地址>:3000/trace`。
2. 在登录页填写个人邮箱，例如 `user@example.com`。
3. 单击 **登录**。
4. 确认进入 **链路追踪** 页面。

首次使用该邮箱时，平台创建账号并分配数据上报 API Key；再次输入相同邮箱会使用已有账号。后续应使用同一账号完成接入与查询。

独立模式使用邮箱作为账号标识，不校验邮箱所有权，也不包含密码或邮件验证码流程。共享部署时应由管理员配置访问控制。企业模式是否启用由管理员配置；启用后按企业登录入口完成登录。

## 接入前提

在 AcTrail 实际运行的 Linux 主机上确认以下条件：

- 已安装并启动 AcTrail，`actraild` 可执行文件可找到。
- 已安装 AcTrail 官方 `otel-http` 插件，版本支持完整请求和工具结果导出配置。
- 已安装 Bash、curl 和 Node.js 20 或以上版本。
- 当前用户可使用 root 或 sudo 权限管理 AcTrail 插件和配置。使用 sudo 时，确认 `sudo node --version` 同样可执行；仅在普通用户的 nvm 环境中配置 Node.js 可能无法满足这一条件。
- 客户端可以访问浏览器中显示的平台地址。

接入命令配置 AcTrail 的上报插件，不安装 AcTrail 本身。

## 配置数据上报

1. 使用要归属这些链路的账号登录平台。
2. 在左侧导航栏选择 **配置 > 安装指导**。
3. 核对右侧的当前账号、平台地址和 **你的 API Key**。
4. 单击 **Linux** 命令卡片中的 **复制**。
5. 在 AcTrail 所在 Linux 主机的终端执行复制的命令。

   页面命令已包含当前账号的 API Key，无需再次替换占位符。命令形态如下：

   ```bash
   curl -sSf "http://<平台地址>:3000/api/ingest/setup?key=<当前账号API_KEY>&yes=1&frameworks=actrail" | bash
   ```

   示例仅表示格式，实际执行时使用自己的页面命令。平台与客户端分开部署时，平台地址必须是客户端可达的地址，不能误用指向客户端自身的 `localhost`。

6. 按终端提示完成权限操作。
7. 确认终端显示 `已完成 AcTrail 数据对接配置`。

脚本可能更新并重启 AcTrail 守护进程以应用采集配置。完成后，插件实例名为 `agent-insight.otel-http`，插件配置位于 `~/.agent-insight/actrail/otel-http.config.toml`。数据发送到平台的 `/api/ingest/otel/v1/traces`。

含 API Key 的接入命令和插件配置应按凭证管理，不要复制到公共文档或公开问题报告。

## 非默认 AcTrail 安装目录

使用自定义目录时，在执行页面命令前设置对应变量。只需设置与实际环境不同的项：

```bash
export ACTRAILD_BIN='/path/to/actraild'
export ACTRAIL_OPERATOR_CONFIG='/path/to/actraild.conf'
export ACTRAIL_PLUGIN_DIR='/path/to/plugins'
```

- `ACTRAILD_BIN`：`actraild` 可执行文件路径。
- `ACTRAIL_OPERATOR_CONFIG`：守护进程配置文件路径，默认 `/etc/actrail/actraild.conf`。
- `ACTRAIL_PLUGIN_DIR`：包含 `otel-http` 子目录的插件根目录。

未显式设置插件目录时，脚本依次查找 `~/.actrail/plugins/otel-http/`、`/usr/share/actrail/plugins/otel-http/` 和 `/etc/actrail/plugins/otel-http/`。

## 验证接入结果

1. 按现有 AcTrail 使用方式，通过 `actrailctl launch` 启动一次真实 Agent 任务。
2. 返回 Agent Insight，选择 **运行观测 > 链路追踪**。
3. 选择覆盖任务执行时间的时间范围。
4. 查找本次任务对应的 Trace。
5. 打开 Trace 详情。
6. 核对 Agent、LLM 和工具节点，以及输入、输出等信息是否与本次任务一致。

只执行接入脚本不会生成真实业务 Trace。页面中已有的示例数据也不能代替这次接入验证。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 提示未找到 Node.js | 在 AcTrail 所在主机安装 Node.js 20 或以上版本，确认 `node --version` 可执行。 |
| 提示未找到 `actraild` | 先完成 AcTrail 安装并检查 PATH，或设置 `ACTRAILD_BIN`。 |
| 提示未找到 `otel-http` 插件 | 安装包含该官方插件的 AcTrail，或设置正确的 `ACTRAIL_PLUGIN_DIR`。 |
| 提示不支持完整请求或工具结果导出配置 | 按提示升级 AcTrail，再重新执行接入命令。 |
| 提示需要 root 权限 | 使用具备权限的账号运行，或配置可用的 sudo 权限。 |
| 配置完成但列表没有 Trace | 确认插件已加载、平台地址可达、API Key 属于当前账号，并实际执行了一次任务；清除不相关筛选后重试查询。 |
| 切换账号后找不到原来的 Trace | 查看数据时使用配置上报命令所归属的账号；需要更换归属时，从新账号页面重新复制并执行接入命令。 |
