# Agent RAS 配置示例

运行时读取：`~/.agent-insight/ras/config.json`（可用环境变量 `AGENT_INSIGHT_RAS_HOME` 覆盖目录）。

| 文件 | 用途 |
|------|------|
| [`agent_ras_config.default.yaml`](./agent_ras_config.default.yaml) | 跨平台能力默认（`enabled` / `detectors` / `recovery`）；**新增能力时改此文件** |
| [`agent_ras.inproc.example.json`](./agent_ras.inproc.example.json) | 同进程配置**形状**说明；`service.*` 使用占位路径；加域时**不要**改 |

正常情况下不要手工复制本机配置，直接执行：

```bash
npx agent-insight install-ras
```

安装器会探测 Python、共享 libpython 和 pip，幂等生成**本机** `~/.agent-insight/ras/config.json`，并在缺省时从 `agent_ras_config.default.yaml` 合并 detectors/recovery（不覆盖已有阈值，不写假 `service` 路径）。

**不要**把真实 home / conda / libpython 路径写进仓库示例或文档后提交。

验证同进程运行时：

```bash
node scripts/install-ras.js --check
RAS_LIBPYTHON=/path/to/libpython3.X.so PYTHONHOME=/path/to/python-prefix \
  bash agent_ras/scripts/smoke_inproc.sh
python3 -m pytest agent_ras/tests/unit_tests -q
```
