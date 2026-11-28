# 部署案例与操作指南

实际部署的命令、端口、权限和启停方式见 [Docker 部署指南](../../../docs/zh/how-to/platform/deploy-docker.md)。源码安装、配置校验和数据库授权见 [Storage Core 指南](../../../docs/zh/how-to/platform/storage-core.md)。

| 场景 | 使用的交付文件 |
|---|---|
| 整体启动，默认 PostgreSQL | [一键部署入口](../../../scripts/deploy-docker.sh) |
| 分别启动数据库 | [PostgreSQL](../../../deploy/docker/compose.postgresql.yml)、[openGauss](../../../deploy/docker/compose.opengauss.yml)、[SQLite 服务](../../../deploy/docker/compose.sqlite.yml)、[ClickHouse](../../../deploy/docker/compose.clickhouse.yml) |
| 仅运行项目容器 | [项目 Compose](../../../deploy/docker/compose.app.yml) |
| 项目连接配置示例，每份包含 ClickHouse | [PostgreSQL](../../../deploy/docker/storage.postgresql.example.json)、[openGauss](../../../deploy/docker/storage.opengauss.example.json)、[SQLite 网络服务](../../../deploy/docker/storage.sqlite.example.json) |

数据库与项目由不同人员部署时，数据库管理员提供从项目所在网络可达的地址和端口、库名、专用账号及凭据、TLS 信任信息。SQLite 服务用令牌认证。项目管理员据此填写私有 JSON，并为制品选择可写的持久目录。同机 Compose 可使用服务名及容器端口。源码运行时改用数据库对应用宿主机提供的地址，并把制品和运行目录改为该宿主机上的路径。

本目录的 `examples/` 保存方案评审时的样例。发布和部署使用上表链接的交付文件。
