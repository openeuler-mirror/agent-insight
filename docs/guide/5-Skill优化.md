# Skill 优化

> **版本**: v5.0.0
> **更新日期**: 2026年4月

---

## 1. 功能说明

传统的 Skill 优化主要依赖"任务结果是否正确"这一信号，缺少执行过程数据的支撑，只能做浅层调整。Agent-insight 的优化方式不同——它基于评测环节采集到的全链路执行数据（每一步操作、工具调用、流程偏差等），自动定位 Skill 中的具体缺陷，进行针对性修补。

典型场景包括：环境漂移、依赖缺失、参数不匹配、缺少备份/回滚步骤、逻辑漏洞等。你不需要手动修改脚本，只需在 Agent 终端中用自然语言描述优化需求，就能完成定位、修补和重试。

这使得优化从"基于结果的试错"变为"基于数据的工程过程"，形成 **评测 → 优化 → 再评测** 的持续改进闭环。

---

## 2. 在 Agent 终端中触发优化

### 2.1 前置准备 - 给 Agent 注入优化能力

在 Agent 的工作终端中执行以下命令，安装 Agent-insight Meta-Skill：

```bash
npx skills add https://gitcode.com/openeuler/witty-skill-insight.git
```

根据指引，选择安装skill-optimizer、skill-sync，并选择合适的集成框架（如Opencode）。完成后，Agent 就可以通过自然语言调用 Skill 优化能力，并且将优化后的 Skill 同步到 Agent-insight 平台管理起来。

### 2.2 基本用法

完成一次任务执行后，如果对执行结果不满意，可以在 Agent 终端中触发 Skill 优化。例如：

```bash
根据执行记录，优化一下 `<Skill 名称>`。
```

如果使用Opencode，可以直接使用如下指令触发指定 Skill 的优化：

```bash
/si-optimizer <待优化的Skill路径>
```

### 2.3 指定优化方向

如果你清楚问题大致出在哪里，可以在指令中给出更具体的要求：

```bash
根据终端里最后的报错和执行记录，优化 `<Skill 名称>`：
1) 补齐依赖和前置校验；2) 避免破坏原有正确路径；3) 给出修复点与验证证据。
```

### 2.4 多轮迭代自优化(仅支持Opencode)

如果你只关注优化结果，但是不想要每次都手动执行优化，可以在工作目录下创建`iter-config.yaml`文件，内容示例如下：

```yaml
# ============================================================================
# 迭代优化任务配置 - openeuler-docker-fault skill
# ============================================================================

# 任务执行框架，当前仅支持opencode
framework: opencode

# 待优化的skill名字以及路径
skill:
  name: openeuler-docker-fault
  path: /root/home/gyc/run_opencode/.opencode/skills/openeuler-docker-fault

# 优化目标，下面达成其一则停止优化：
# score_threshold - 任务准确率目标
# max_rounds - 优化轮数上限
optimization:
  score_threshold: 0.8
  goal: skill 能准确识别 docker 容器卡顿的根因，排查建议包含具体命令和预期输出
  max_rounds: 2

# 默认模型（可选），通过 opencode models 命令获取可用的模型
# 配置后跳过模型选择，直接使用该模型执行所有 opencode run
model: your-model

# 故障注入（可选）
# 每轮测试任务执行前注入故障，执行后停止故障
fault_injection:
  inject: bash /root/home/gyc/inject/euler_os_inject.sh --start
  cleanup: bash /root/home/gyc/inject/euler_os_inject.sh --stop

# 优化测试任务，用于验证skill是否有效
tasks:
  query: |
    我在本机部署的redis docker应用有时会卡顿，使用相关技能帮我分析下原因，并给出详细分析结果

# 预设交互，任务执行过程可能出现的交互，配置后由Agent自动回复
interactions:
  - scenario: 询问是否加载优化后的 skill
    trigger: 是否加载|加载优化|是否使用优化|是否应用
    response: 直接加载

  - scenario: 询问是否有反馈意见
    trigger: 反馈意见|反馈|还有什么|其他建议|补充
    response: 无反馈意见

```

完成上述文件配置后，执行如下命令即可开启迭代优化任务：

```bash
/si-optimizer
```

---

## 3. 优化后的常见变化

优化完成后，你通常会看到以下一种或多种改动：

- **增加前置检查**：例如权限校验、命令是否存在、路径是否可用等
- **适配环境差异**：例如不同发行版的命令参数差异、依赖库名称变化等
- **修复解析逻辑**：例如从输出中提取字段的正则表达式或分支逻辑修正
- **增强错误处理**：例如更完善的异常捕获、回滚提示等

---

## 4. 优化效果不理想时的建议

如果优化器反复修不好或输出不稳定，建议在指令中补充以下信息：

- **关键报错**：贴上终端中最后几行错误输出
- **保护约束**：说明哪些已有行为不能改变（例如"不要改变已有成功路径"）
