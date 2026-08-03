# Agent RAS 配置示例

运行时读取：`~/.agent-insight/ras/config.json`（可用环境变量 `AGENT_INSIGHT_RAS_HOME` 覆盖目录）。

| 文件 | 用途 |
|------|------|
| [`agent_ras.inproc.example.json`](./agent_ras.inproc.example.json) | 同进程（`transport: inproc`，唯一方案） |

正常情况下不要手工复制配置，直接执行：

```bash
npx agent-insight install-ras
```

安装器会探测 Python、共享 libpython 和 pip，安装 Python 依赖，并幂等生成配置。
示例文件仅用于开发调试；其中路径必须替换为当前机器的实际安装路径。

验证同进程运行时：

```bash
node scripts/install-ras.js --check
bash agent_ras/scripts/smoke_inproc.sh
python3 -m pytest agent_ras/tests/unit_tests -q
```
