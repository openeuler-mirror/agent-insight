# 数据库与项目分离部署 · 需求分析

一键安装面向新实例。运维人员可以接受默认 PostgreSQL，也可以选 openGauss 或 SQLite。已有数据库的用户只需向项目提供服务地址、账号和凭据。每个实例使用一个事务库和一个必选的 ClickHouse。

| 使用方式 | 操作者提供 | 结果 |
|---|---|---|
| Docker 一键 | 新的部署目录，可选事务库类型 | 默认 PostgreSQL。恰好三个长期运行容器，分别运行事务库、ClickHouse、项目。 |
| Docker 分步 | 任一事务库与 ClickHouse 的连接配置 | 四份数据库文件均可独立启动。第五份文件单独启动项目。两个数据库可以位于同机、异机或使用外部托管服务。 |
| 源码安装 | 同样的数据库配置和本机运行环境 | 在宿主机启动 Core 与 Web。数据库由谁启动、是否采用容器，无需填写或探测。 |

数据库各自独占数据卷，项目仅通过端口读写业务数据。项目独立持久化制品、运行配置、密钥及初始化记录。停止项目、替换项目容器和重跑安装都应保留数据。旧 SQLite 文件部署按原显式配置访问，新三容器部署通过 SQLite 服务端口连接。

## 现有基础

- [外部库安装器](../../../scripts/project-storage.cjs)已有配置校验和私有文件检查。[初始化逻辑](../../../scripts/project-storage.py)支持检查两个存储、识别首次安装、拒绝不兼容历史库及中断重试。
- [现有 Compose](../../../docker-compose.storage-core.yml)将 SQLite 放在 Core 容器，Web 与 Core 共享网络命名空间。[Core 检查](../../../scripts/storage-core-preflight.cjs)要求回环地址及私有控制器文件。
- [SQLite 实现](../../../services/storage/control.py)直接打开文件并使用本地事务与备份接口。端口化需要服务端和适配器。[现行操作指南](../../../docs/zh/how-to/platform/storage-core.md)记录了 openGauss 的适配及实测范围。

[详细设计](phase2-requirements-design.md) · [开发计划与验收](phase3-development-plan.md) · [案例操作指南](guide.md)
