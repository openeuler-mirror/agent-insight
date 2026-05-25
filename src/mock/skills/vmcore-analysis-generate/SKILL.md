---
name: vmcore-analysis
description: >
  Analyze Linux kernel crash dump files (vmcore) to diagnose OOM, deadlock, kernel panic, hardware errors, NULL pointer dereference, and stack overflow. Triggered when user mentions vmcore, kernel crash dump, kernel panic analysis, crash tool, kdump, or needs to analyze system crash root cause. This skill uses crash tool to extract diagnostic information from vmcore files and identify fault patterns through structured analysis workflow.
---

# Vmcore Analysis - Linux 内核崩溃转储分析

> 适用: Linux 系统(需 crash 工具和 kernel-debuginfo) | 版本: v1.0

## 概述 (Overview)

本 Skill 用于分析 Linux 内核崩溃转储文件(vmcore),通过 crash 工具提取关键诊断信息,识别 OOM Killer、Kernel Panic、Deadlock、硬件错误、空指针解引用和栈溢出等故障模式,帮助定位内核崩溃的根本原因。

## 核心指令 (Core Instructions)

### Step 1: 信息采集

运行基础信息采集,验证环境并获取 vmcore 基本信息:

```bash
VMCORE_PATH=/path/to/vmcore sudo -E bash scripts/collect.sh | tee /tmp/vmcore_collect.json
```

> 注意: 需要先安装 crash 工具和对应的 kernel-debuginfo 包

### Step 2: 故障模式识别

根据用户描述的现象和初步采集结果,从以下故障模式中选择最匹配项:

| # | 故障模式 | 典型现象 | 排查脚本 |
|---|---|---|---|
| 1 | OOM Killer | 内存耗尽导致进程被杀,日志含 "Out of memory: Kill process" | `scripts/check_oom.sh` |
| 2 | Kernel Panic | 内核崩溃,日志含 panic 信息,系统停止响应 | `scripts/check_panic.sh` |
| 3 | Deadlock | 多进程互锁,进程处于 TASK_UNINTERRUPTIBLE 状态 | `scripts/check_deadlock.sh` |
| 4 | Hardware Error | MCE 硬件故障,日志含 Machine Check Exception | `scripts/check_hardware.sh` |
| 5 | NULL Pointer | 空指针解引用,调用栈含 BUG 或 invalid 地址 | `scripts/check_nullptr.sh` |
| 6 | Stack Overflow | 调用栈过深(>50层),栈指针超出边界 | `scripts/check_stack.sh` |

> 若无法确定,优先选择现象最接近的模式。当前模式未命中时,回到本表选择下一个候选。

### Step 3: 执行排查

运行选定故障模式对应的排查脚本:

```bash
VMCORE_PATH=/path/to/vmcore sudo -E bash scripts/check_{selected}.sh
```

结果解读:
- **命中 (hit)** → 根据脚本输出的诊断结论定位根因
- **未命中 (miss)** → 返回 Step 2 选择下一个故障模式

> **追问原则**: 命中故障后继续追问以下三个问题:
> 1. 何时开始? — 调用 timeline 回溯日志时间线
> 2. 何事触发? — 检查崩溃前的系统活动和变更记录
> 3. 影响范围? — 检查是否涉及多进程或多 CPU

### 兜底

所有故障模式均未命中时:
1. `VMCORE_PATH=/path/to/vmcore sudo -E bash scripts/collect.sh --full`
2. 手动使用 crash 工具深度分析:
   ```bash
   crash /path/to/vmcore /usr/lib/debug/lib/modules/$(uname -r)/vmlinux
   crash> log | grep -i error
   crash> bt -a
   crash> ps -a
   crash> kmem -i
   ```
3. 上报至内核开发团队或厂商支持

### 诊断结论模板

```
故障根因: [OOM/Panic/Deadlock/Hardware/NULL_Ptr/Stack_Overflow]
故障组件: [内核模块/驱动/硬件组件]
故障时间: [首次出现时间] → [崩溃确认时间]
故障链:   [T1]触发事件 → [T2]故障发生 → [T3]系统崩溃
已排除:   {其他故障模式}: {未命中的依据}
定位依据: {关键证据:日志/寄存器/调用栈}
修复建议: 
  临时: [重启/限制资源/禁用模块]
  根因: [升级内核/修复驱动/更换硬件]
  预防: [监控/调优/配置调整]
```

## 参考文件说明

- `scripts/_lib.sh`: 排查脚本通用函数库(hit/miss/timeline 等)
- `scripts/collect.sh`: vmcore 基础信息采集
- `scripts/check_oom.sh`: OOM Killer 排查脚本
- `scripts/check_panic.sh`: Kernel Panic 排查脚本
- `scripts/check_deadlock.sh`: Deadlock 排查脚本
- `scripts/check_hardware.sh`: 硬件错误排查脚本
- `scripts/check_nullptr.sh`: NULL 指针排查脚本
- `scripts/check_stack.sh`: Stack Overflow 排查脚本
- `references/crash_tool_guide.md`: crash 工具使用指南(如有需要)