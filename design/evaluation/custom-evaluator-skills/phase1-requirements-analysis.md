# 自建评估器 Prompt + Skills：需求分析

## 1. 目标与已确认约束

在「评估器 → 自建评估器 → 新建自定义评估器」及其编辑页面，为现有提示词评估器增加可选的 Skills 配置。Prompt 继续定义评判目标、标准与评分点；Skills 补充验证步骤、脚本和参考资料，由评估器 Agent 在评判时使用。

本方案中的 Skill 是**评估器使用的能力**，与被评测 Agent 的 Skill、实验关联的 Skill、数据集中的可用能力目录分别建模。

用户已确认：

- 采用 **Prompt + Skills**，两者可组合，Prompt 必填，Skills 可为空。
- 支持添加多个 Skill、查看文件和移除。
- 第一期不做启停；添加的 Skill 全部参与评估，不需要就移除。
- 「添加 Skill」支持「从 Skill 库选择」与「从电脑中导入文件夹」两种来源，可混合添加。
- 从已有 Skill 库添加时固定版本，不自动跟随最新版本或激活版本。
- 本地导入仅支持根目录含 `SKILL.md` 的文件夹，仅随评估器保存，不自动加入 Skill 库。
- 本轮交付设计方案，功能实现待设计对齐后开展。

## 2. 当前实现与差距

| 位置 | 当前能力 | 本需求涉及的差距 |
|---|---|---|
| `src/components/EvaluatorsCenter.tsx` | 自建评估器列表与创建面板，配置 Prompt 和可选评分点 | 没有 Skills 区域 |
| `src/app/(main)/metrics/evaluators/[id]/page.tsx` | 详情编辑，支持历史 System/User Prompt | 没有 Skill 版本与文件展示 |
| `src/lib/evaluators/custom-evaluator-model.ts` | `LlmEvaluatorConfig` 包含 model、systemPrompt、userPrompt | 缺少 Skill 绑定契约 |
| `src/server/user_evaluators_storage.ts` | 按用户将卡片数组存入 `CustomEvaluatorList.itemsJson` | 可增量保存 Skill 绑定，但需服务端校验与冻结 |
| `src/lib/engine/experiment/run-experiment.ts` / `judge-llm.ts` | 全局实验组装提示词，默认直连 LLM，支持 OpenCode 回退 | 没有 Skill 加载、工作目录与运行证据 |
| `src/lib/engine/evaluation/custom-llm-evaluator.ts` | 轨迹评测入口已有 OpenCode 临时进程，隔离 HOME，session 位于 `/tmp` | 没有挂载选定 Skill；只解析旧 score/reason 契约 |
| `Skill` / `SkillVersion` | 有版本号、SKILL.md 正文、附属文件清单和文件目录 | 固定版本号仍需冻结文件，避免源资产变化影响评估 |
| `Experiment.configSnapshotJson` | 已有实验冻结配置容器，各入口内容不完全一致 | 需增加统一的自建评估器快照，并覆盖复测和监听入口 |

`runCustomLlmEvaluator` 的 `skillName/skillVersion` 参数目前只用于后台任务归属，不能复用为评估器 Skills。

现有 `loadSkillVersionSnapshot` 为锚点分析而设计，会跳过缺失、大文件并按 UTF-8 读取；不能直接用它打包可执行 Skill，否则脚本或二进制资料可能被静默遗漏。

## 3. 第一期范围建议

### 3.1 纳入

1. 从当前用户可访问的已有 Skill 库选择明确版本，或直接从电脑导入 Skill 文件夹。
2. 两种来源统一冻结完整文件包，展示名称、来源、库版本或本地导入摘要、文件数；支持只读文件查看与移除。本地文件上传到平台，不依赖原电脑持续在线，也不创建 Skill 库记录。
3. Skills 为空时沿用各入口现有提示词执行方式；非空时强制走 OpenCode，完整加载所有已添加 Skill。
4. 全局实验与轨迹评测的自建评估器共用 Skills 执行能力，保留各自结果适配。
5. 新实验冻结 Prompt、评分点和 Skill 文件快照，重试、追加 Case、监听与复用同配置使用同一份快照。
6. 结果提供本次实际使用的 Skill 名称、版本和内容摘要，以及工具执行证据。
7. 使用现有实验或轨迹评测入口完成端到端验收。

### 3.2 暂不纳入

- 每个 Skill 的启停、必选/可选、权重、优先级开关。
- 在评估器内编辑、生成 Skill，或将本地导入自动发布到 Skill 库。
- MCP 配置、其他 Agent 运行时选择、新的 Code/RPC 评估器。
- 独立试运行面板、工作流编排、自动安装脚本依赖。
- 改造全部预置评估器，或将所有提示词评测强制迁移到 OpenCode。
- 完整裁判对话回放页面与原始思考内容展示。

这些是控制第一期范围的设计建议；用户已确认的功能约束以第 1 节为准。

## 4. 参与评估的准确含义

所有添加的 Skill，其 `SKILL.md` 指令都必须进入该次评估上下文，完整文件包都必须在该次独立工作目录中可访问；不得只展示名称或仅让 Agent 自行决定是否加载。

是否执行某个脚本、查阅某份参考资料，按 Skill 中的适用条件和本条 Case 决定。添加 Skill 不等于无条件运行它的每一个脚本。平台分别记录“已加载的 Skill”和“实际发生的工具调用”，不能以配置列表伪造调用证据。

若任一已添加 Skill 无法准备或完整加载，本条自建评估器失败，不静默忽略该 Skill，也不降级为普通 Prompt 评测。

## 5. 典型使用路径

1. 用户编写“检查生成的报表是否与输入数据一致”的评估 Prompt。
2. 点击「添加 Skill」，从库中选择 `report-validator` 的 v2，查看 `SKILL.md`、校验脚本与参考文件。
3. 保存评估器，系统冻结该版本文件。
4. 在新实验中选择此评估器，OpenCode 读取评估输入和文件，按 Skill 规则执行验证，输出统一评分结果。
5. 用户在结果中看到本次使用的 `report-validator v2`、验证工具结果和评分依据。
6. 库中出现 v3 不影响已有评估器。用户需显式更换绑定版本并保存，后续新实验才使用新配置。
7. 移除 Skill 并保存后，新实验不再加载它；已经冻结的实验保持原配置。

本地导入路径：点击「添加 Skill → 从电脑中导入文件夹」，直接打开系统文件夹选择器，选择一个完整 Skill 文件夹；纯主指令 Skill 也需将 `SKILL.md` 放入文件夹，ZIP 需先解压。预览文件清单并确认后添加到表单，保存时形成评估器私有快照。修改电脑上的文件不会自动生效，需移除原项、重新添加并保存；不提供「重新导入」按钮；取消编辑保留原绑定。整个过程不创建或更新 `Skill/SkillVersion`。

## 6. 验收要求

| 编号 | 验收要求 |
|---|---|
| AC1 | 旧评估器无 Skills 时可查看、编辑、运行，行为不因本需求自动改变 |
| AC2 | 创建与编辑支持多个 Skill，两种来源可混用；库来源版本明确，本地来源显示导入摘要，不显示启停开关 |
| AC3 | 列表可查看对应冻结文件；移除只解除绑定，不删除源 Skill |
| AC4 | 源 Skill 升级、激活版本切换或源文件变化，不改变已保存快照 |
| AC5 | 所有添加的 Skill 主指令均实际进入评估请求，脚本与参考资料保持完整 |
| AC6 | 用确需脚本验证的 Case，观察到真实工具调用，评分依据包含可核验结果 |
| AC7 | 有 Skills 时 OpenCode 不可用、文件损坏或加载失败，明确失败且无伪造分数 |
| AC8 | 全局实验、轨迹评测均支持；结果格式、人工修正与聚合规则保持兼容 |
| AC9 | 实验重试、监听追加、复用同配置不会混用修改前后的评估器配置 |
| AC10 | 并发 Case 使用独立工作目录；不自动加载宿主机的其他 Skills |
| AC11 | 无权读取的源 Skill、同名冲突、路径越界等配置被服务端拒绝 |
| AC12 | 更新用户指南与开发者指南，并经用户确认后执行浏览器主路径及边界验收 |
| AC13 | 仅通过文件夹导入，脚本/资料完整；ZIP 与单文件请求拒绝；缺少主文件、多个 Skill 根目录、非法路径或超限明确拒绝 |
| AC14 | 本地导入及移除后重新添加不创建或更新 Skill 库资产；电脑文件修改不自动同步，保存后的评估无需访问原电脑 |
| AC15 | 未保存导入有临时有效期，取消或失败不改变已有评估器；跨用户临时凭证不可用，过期后提示移除后重新添加 |
| AC16 | 结果详情不重复展示 Skills；仅有真实可访问 Agent 评估记录时显示评估链路，普通 LLM/历史无记录/失效引用不显示 |
| AC17 | 评估器卡片保留原有评分灰框，Skills 数量紧凑展示；复用卡片式 Skill 库选择，文件查看独立只读，本地导入使用系统文件选择器 |

## 7. 产品参考与取舍

- [AgentLoop 评估器](https://help.aliyun.com/zh/agentloop/user-guide/evaluator/)：采用 Prompt 与能力挂载组合，输出评分与依据；借鉴这一产品模型，不照搬全部类型与配置项。
- [AgentLoop 评估器 Skill 接口](https://help.aliyun.com/zh/agentloop/developer-reference/api-agentloop-2026-05-20-createevaluatorskill)：Skill 具有独立名称与文件列表；本项目以两种来源导入统一快照，本地导入仅作为评估器附件，不增加独立资产管理中心。
- [Langfuse 评估器](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge)与 [MLflow Judge Builder](https://mlflow.org/docs/latest/genai/eval-monitor/scorers/llm-judge/custom-judges/create-custom-judge/)提供样本试跑；此交互可后续扩展，第一期通过现有评测入口验证。

以上为官方文档支持的产品参考，不据此推断 AgentLoop 使用 OpenCode。
