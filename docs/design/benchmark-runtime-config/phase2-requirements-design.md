# Benchmark 业务配置文件：需求设计

`config/platform.yaml` 管理数据准备和平台调度，`config/evaluator.yaml` 管理评测并发、SWE-bench 运行配置与镜像池，`config/executor.yaml` 管理 Case Git 来源。

加载顺序为程序默认值、项目 YAML、同目录 `*.local.yaml`。对象深度覆盖，数组整体替换；可为空的字段通过 `null` 恢复默认语义。本地覆盖不提交 Git。相对路径按声明文件目录解析；Evaluator Python 是容器内命令或绝对路径。

统一加载器拒绝未知字段、重复 YAML key、错误类型及跨字段冲突，并输出文件与字段位置。配置目录由安装根定位，`AGENT_INSIGHT_CONFIG_DIR` 可覆盖部署路径。解析器分发复用已安装 js-yaml 的独立发行文件，不要求客户端或 Controller 安装额外 Node 依赖。

Evaluator 启动脚本在现有 Controller 镜像中预检宿主配置，成功后生成完整 JSON 快照，供 Controller 和 OCI Runtime 共用；预检失败不替换旧服务。快照属于内部传递机制，不开放业务环境覆盖。

平台数据准备配置错误不阻止服务启动。数据导入独立命令仍返回非零错误码，`autoImport=false` 不禁用已有数据集或手动导入。通信地址的既有运行时文件保持独立。
