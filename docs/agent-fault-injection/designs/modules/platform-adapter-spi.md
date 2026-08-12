# Platform Adapter SPI 对照表（V1a）

> 验证门禁：OpenCode / xiaoO cli / xiaoO daemon 每步均有归属后，才落地 Template Method。  
> 结论：**通过** — 公共步骤上收；平台差异收敛到 SPI；daemon 作为同一 Adapter 内策略。

| 步骤 | OpenCode | xiaoO cli | xiaoO daemon | 归属 |
|------|----------|-----------|--------------|------|
| validate workspace | `validate_workspace` | 同左 | 同左 | **共享** `lifecycle` |
| install tools/skill | `_install_fault_tools` | tools + `_install_fault_skill` | 同 cli | **SPI** `install_fault_assets` |
| assert tools | shared assert | 同左 | 同左 | **共享** |
| copy SKILL.md artifact | shared | 同左 | 同左 | **共享** |
| `apply_injection_plan` | shared | 同左 | 同左 | **共享** |
| isolation / overlay | `_prepare_isolated_environment` | `prepare_overlay` | 同 cli | **SPI** `prepare_runtime_isolation` |
| build AGENT_FI_* | `build_fi_injection_env` | 同左 | 同左 | **共享** |
| merge platform env | OpenCode XDG/OPENCODE_* | XIAOO_CONFIG / PYTHONPATH / events | 同 cli | **SPI** `merge_platform_env` |
| build launch | `_build_command` | `_build_cli_command` | daemon HTTP session | **SPI**（在 `run_platform_session` 内） |
| wait ready | plugin_ready file | plugin_ready / mark_ready | daemon ready | **SPI**（在 `run_platform_session` 内） |
| monitor until exit | ProcessMonitor | ProcessMonitor | daemon poll | **SPI** `run_platform_session` |
| map_trajectory | OpenCode mapper | XiaoO mapper | 同左 | **SPI** `map_trajectory` |
| cleanup | InstallSession + rmtree isolation | 同左 | 同左 | **共享** cleanup + **SPI** `teardown_isolation` |

## SPI 必填

- `install_fault_assets`
- `prepare_runtime_isolation`
- `merge_platform_env`
- `run_platform_session`（含 launch / wait / monitor；允许 harness 分支）
- `teardown_isolation`
- `map_trajectory`

## 明确不做

- 完整 Ports 六边形（与 SPI 重复）
- 为 cli/daemon 各建一套 Template Method
