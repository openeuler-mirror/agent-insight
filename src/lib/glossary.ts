// docs/agent-insight-glossary.md 的运行时索引。
// 这里是 Term / TermPopover 组件的唯一事实来源。
// 增改条目时请同步 docs/agent-insight-glossary.md，保持文档与代码一致。
import type { TermTag } from '@/components/text/TermPopover';

export interface GlossaryEntry {
  /** 显示名（中文，对应 glossary md 表格里的"名词"列）。 */
  name: string;
  /** 6 类语义标签，决定 popover 顶部 tag 配色。 */
  tag: TermTag;
  /** 简短解释，1-3 句。长篇解释请放到 docs/。 */
  body: string;
  /** 可选：公式/计算口径，等宽渲染。 */
  formula?: string;
}

const GLOSSARY = {
  // ===== §1 概览 =====
  'agent': {
    name: 'Agent',
    tag: 'metric',
    body: '接入到本平台的智能体实例，对应一个真实运行的对外服务进程。',
  },
  'user-agent': {
    name: '用户 Agent',
    tag: 'metric',
    body: '通过客户端接入本平台的 Agent 实例，由用户/团队自行注册和维护。',
  },
  'system-agent': {
    name: '系统 Agent',
    tag: 'metric',
    body: '平台内置的 Agent，用于支撑平台自身功能（如智能诊断）。',
  },
  'unregistered-agent': {
    name: '未注册 Agent',
    tag: 'metric',
    body: '已上报过数据、但尚未在"Agent 管理"中正式登记的 Agent。',
  },
  'agent-ownership': {
    name: 'Agent 归属',
    tag: 'metric',
    body: '标识 Agent 的来源，取值为：用户 Agent、系统 Agent、未注册 Agent。',
  },
  'main-agent': {
    name: '主 Agent',
    tag: 'trace',
    body: '直接接收用户请求的入口 Agent，执行过程中可派生子 Agent。',
  },
  'platform': {
    name: '平台',
    tag: 'metric',
    body: 'Agent 运行所基于的底层框架/Runtime（如 opencode）。一个 Agent 只能属于一个平台。',
  },
  'p95-latency': {
    name: 'P95 时延',
    tag: 'metric',
    body: '所有请求按耗时排序后第 95 百分位的耗时，反映长尾体验。',
    formula: 'sort(durations)[ceil(0.95 × n)]',
  },
  'agent-status': {
    name: 'Agent 状态',
    tag: 'metric',
    body: '运行中 / 异常 / 空闲 三态，由心跳与最近一次执行结果共同判定。',
  },

  // ===== §2 Agent 管理 =====
  'connected-agent': {
    name: '接入 Agent',
    tag: 'metric',
    body: '已通过 SDK 或配置完成对接、可向平台上报 Trace 的 Agent。',
  },
  'agent-type': {
    name: 'Agent 类型',
    tag: 'metric',
    body: '区分 主 Agent（入口）与 子 Agent（由主 Agent 派生执行子任务）。',
  },
  'custom': {
    name: 'Custom',
    tag: 'metric',
    body: 'Agent 的来源类型，表示自定义实现，与"模板"或"预置"相对。',
  },
  'trace-link': {
    name: '链路跟踪',
    tag: 'trace',
    body: '跳转到该 Agent 最近若干次执行的全链路 Trace 视图。',
  },
  'smart-diagnosis': {
    name: '智能诊断',
    tag: 'fault',
    body: '对该 Agent 最近一次失败/异常调用进行 AI 归因分析。',
  },

  // ===== §3 链路追踪 =====
  'trace': {
    name: 'Trace',
    tag: 'trace',
    body: '一次完整任务执行从入口到结束的全部调用记录，由若干 Span 组成。',
  },
  'span': {
    name: 'Span',
    tag: 'trace',
    body: 'Trace 中的单个执行片段，可代表一次 LLM 调用、工具调用或子 Agent 派生。',
  },
  'tool-error-rate': {
    name: '工具错误率',
    tag: 'metric',
    body: '工具调用失败次数占总工具调用次数的比例。',
    formula: 'failed_tool_calls / total_tool_calls',
  },
  'main-agent-only': {
    name: '仅主 Agent',
    tag: 'trace',
    body: '筛选项，只展示由主 Agent 发起的根 Trace，过滤子 Agent 派生记录。',
  },
  'multi-agent': {
    name: 'Multi-Agent',
    tag: 'trace',
    body: '标签，表示该 Trace 中存在多个 Agent 协同（含主-子派生）。',
  },
  'task-spawns': {
    name: 'TASK SPAWNS',
    tag: 'trace',
    body: '一次 Trace 中派生子任务/子 Agent 的次数。',
  },
  'tool-calls': {
    name: 'TOOL CALLS',
    tag: 'tool',
    body: '一次 Trace 中工具调用的次数。',
  },
  'skill-calls': {
    name: 'SKILL CALLS',
    tag: 'skill',
    body: '一次 Trace 中命中并调用 Skill 的次数。',
  },
  'llm-turns': {
    name: 'LLM TURNS',
    tag: 'trace',
    body: '一次 Trace 中与底层模型的对话轮次。',
  },
  'tokens': {
    name: 'Tokens',
    tag: 'metric',
    body: '模型消耗的 Token 总量，分 INPUT / OUTPUT / CACHE READ。',
  },
  'cache-read': {
    name: 'CACHE READ',
    tag: 'metric',
    body: '命中提示词缓存而被复用的 Token 数，计费远低于普通 Input。',
  },
  'depth': {
    name: 'depth',
    tag: 'trace',
    body: '当前节点在 Trace 树中的层级深度，0 为根节点。',
  },
  'fault-diagnosis': {
    name: '故障诊断',
    tag: 'fault',
    body: '对当前 Trace 触发 AI 归因分析，跳转到智能诊断页面。',
  },

  // ===== §4 智能诊断 =====
  'execution-session': {
    name: 'Execution Session',
    tag: 'trace',
    body: '一次完整的执行会话，对应一次 Trace。',
  },
  'insight-ai': {
    name: 'Insight AI',
    tag: 'fault',
    body: '平台内置的诊断 Agent（FAULT-DIAGNOSIS-AGENT），读取 Trace 上下文并产出归因结论。',
  },
  'fault-item': {
    name: '故障条目',
    tag: 'fault',
    body: '诊断 Agent 在一次执行中识别出的独立问题，可并存多个。',
  },
  'fault-raw-error': {
    name: '原始错误类故障',
    tag: 'fault',
    body: '系统/工具直接抛出的硬错误，如 Timeout、5xx、权限拒绝。',
  },
  'fault-effect-divergence': {
    name: '效果偏差类故障',
    tag: 'fault',
    body: '未抛错但产出与预期不符的软故障，如答非所问、关键信息遗漏。',
  },
  'fault-mark': {
    name: '故障标记',
    tag: 'fault',
    body: '故障的机读类型，如 TIMEOUT、RATE_LIMIT、OUTPUT_MISMATCH。',
  },
  'chain-status': {
    name: '链路状态',
    tag: 'trace',
    body: '当前 Trace 的最终状态，如 CHAIN_ERROR · L13 表示第 13 个节点处出错。',
  },
  'node-summary': {
    name: '节点摘要',
    tag: 'trace',
    body: '故障所在 Span 的简短描述（如"LLM Provider"）。',
  },
  'match-evidence': {
    name: '匹配依据',
    tag: 'fault',
    body: '诊断 Agent 得出结论时引用的证据来源（节点 ID、字段、上下文）。',
  },
  'cite-node': {
    name: '引用节点',
    tag: 'trace',
    body: '追问 Agent 时可通过 @ 引用具体 Span，让诊断聚焦在该节点上。',
  },

  // ===== §5 评测数据集 =====
  'dataset': {
    name: '评测集',
    tag: 'eval',
    body: '一组带标准答案的测试样本，用于离线评估 Agent 或 Skill 的质量。',
  },
  'dataset-input': {
    name: 'input',
    tag: 'eval',
    body: '评测样本的输入字段，对应用户提问或上游入参。',
  },
  'reference-output': {
    name: 'reference_output',
    tag: 'eval',
    body: '评测样本的标准答案（Ground Truth），用于和 Agent 实际输出做对照。',
  },
  'pending-sync': {
    name: '待同步',
    tag: 'eval',
    body: '数据集已修改但尚未推送到执行端。',
  },
  'latest-pass-rate': {
    name: '最新通过率',
    tag: 'eval',
    body: '该评测集最近一次执行时的通过样本占比。',
  },

  // ===== §6 评估器 =====
  'evaluator': {
    name: '评估器',
    tag: 'eval',
    body: '给实际输出打分的判定器，可以是规则、脚本或 LLM。',
  },
  'evaluator-custom': {
    name: '自建评估器',
    tag: 'eval',
    body: '用户自定义的评估器，需自行配置评分逻辑。',
  },
  'evaluator-preset': {
    name: '预置评估器',
    tag: 'eval',
    body: '平台内置、开箱即用的评估器（如"Agent 任务完成度"）。',
  },
  'llm-judge': {
    name: 'LLM Judge',
    tag: 'eval',
    body: '由大模型担任的评估器，按设定的标尺对输出评分。',
  },
  'score-range': {
    name: '评分 0–1',
    tag: 'eval',
    body: '单项打分取值范围，1 为满分，0 为完全未达预期。',
  },
  'eval-dimension': {
    name: '评估维度标签',
    tag: 'eval',
    body: '评估器关注的维度，如 结果 / 任务完成 / 内容质量 / Agent 通用评测，一个评估器可同时打多个维度。',
  },

  // ===== §7 评测执行 =====
  'eval-batch': {
    name: '评测批次',
    tag: 'eval',
    body: '一次完整评测任务的执行实例，包含若干 Trace 样本。',
  },
  'eval-agent': {
    name: '执行 Agent',
    tag: 'eval',
    body: '本次评测中被测试的 Agent。',
  },
  'auto-observe': {
    name: '自动观测',
    tag: 'eval',
    body: '开启后该批次评测结果将纳入 Skill 综合健康分。',
  },
  'result-eval': {
    name: '结果评测',
    tag: 'eval',
    body: '仅对最终输出与 Ground Truth 做对比的评测维度。',
  },
  'trajectory-eval': {
    name: '轨迹评测',
    tag: 'eval',
    body: '对中间步骤（如调用顺序、是否调用某工具）做评测的维度。',
  },
  'custom-eval': {
    name: '自定义评测',
    tag: 'eval',
    body: '用户自定义评估器对该次执行的额外评分通道。',
  },
  'eval-conclusion': {
    name: '综合评测结论',
    tag: 'eval',
    body: '多维度评分加权后的最终结论与建议。',
  },

  // ===== §8 Skill 管理 =====
  'skill': {
    name: 'Skill',
    tag: 'skill',
    body: '可被 Agent 加载并按需调用的能力包，由一份 SKILL.md 主文档加若干脚本/参考资料组成。',
  },
  'skill-activated-unused': {
    name: '已激活待引用',
    tag: 'skill',
    body: 'Skill 已激活但暂无 Agent 引用，处于"上架但闲置"状态。',
  },
  'skill-progress': {
    name: '流程进度',
    tag: 'skill',
    body: 'Skill 在"生成 → 分析 → 优化"三段生命周期中的位置（如 2/3 表示已完成前两步）。',
  },
  'skill-to-optimize': {
    name: '待优化',
    tag: 'skill',
    body: '已分析出问题、等待进入"优化"环节的 Skill 数。',
  },
  'skill-version': {
    name: '版本',
    tag: 'skill',
    body: 'Skill 的不可变快照，当前激活的版本会被 Agent 实际加载。',
  },
  'skill-lifecycle': {
    name: 'SKILL 生命周期',
    tag: 'skill',
    body: '三阶段流水：①生成（产出 SKILL.md 与脚本）→ ②分析（评估质量）→ ③优化（按分析结果迭代）。',
  },
  'expected-chain': {
    name: '预期执行链路',
    tag: 'skill',
    body: 'Skill 被调用时按 SKILL.md 解析出的步骤序列，用于"声明 vs 实际"的对照。',
  },

  // ===== §9 Skill 生成 =====
  'skill-generation': {
    name: 'Skill 生成',
    tag: 'skill',
    body: '通过对话与模型协作，自动产出 SKILL.md 与配套 scripts/references 目录。',
  },
  'skill-md': {
    name: '主文档',
    tag: 'skill',
    body: 'SKILL.md，Skill 的入口说明书，包含触发条件、核心指令、参数约束等，模型据此决定何时及如何调用。',
  },
  'skill-scripts': {
    name: 'scripts/',
    tag: 'skill',
    body: 'Skill 附带的可执行脚本目录，运行时由 Agent 调用。',
  },
  'skill-references': {
    name: 'references/',
    tag: 'skill',
    body: 'Skill 的参考资料目录，作为模型上下文，本身不可执行。',
  },
  'scenario-template': {
    name: '场景模板',
    tag: 'skill',
    body: '生成时的目标场景类型，影响 SKILL.md 的结构与措辞。',
  },
  'risk-zones': {
    name: '安全区 / 交互区 / 禁止区',
    tag: 'skill',
    body: 'Skill 内部约定的操作风险分层：可自动执行 / 需用户确认 / 绝不执行。',
  },
  'web-search': {
    name: '联网搜索',
    tag: 'tool',
    body: '生成过程中是否允许模型实时检索外部资料。',
  },

  // ===== §10 Skill 分析 =====
  'health-score': {
    name: '综合健康分 · 置信加权',
    tag: 'skill',
    body: 'Skill 当前总分。各维度按权重加权，未跑完的维度不计入分母，故称"置信加权"。',
    formula: 'Σ(score_i × weight_i) / Σ(weight_i, 已完成)',
  },
  'eval-coverage': {
    name: '评估覆盖度',
    tag: 'eval',
    body: '4 个评估维度中已完成评测的占比（如 0/4 维 · 0%）。',
  },
  'one-line-diagnosis': {
    name: '一句话诊断',
    tag: 'fault',
    body: '系统对当前评测状态总结出的结论与建议。',
  },
  'basic-diagnosis': {
    name: '基础诊断',
    tag: 'fault',
    body: '仅依据当前已有数据的浅层诊断，覆盖度低时也能给出。',
  },
  'smart-run': {
    name: 'SMART RUN',
    tag: 'eval',
    body: '一键跑齐缺失维度的批量执行入口，自动调度未跑的评测项。',
  },
  'pending-dimensions': {
    name: '待跑维度',
    tag: 'eval',
    body: '状态为"未配置"或"待分析"、尚未产出分数的评估维度。',
  },
  'four-dim-eval': {
    name: '4 维评估能力',
    tag: 'eval',
    body: '当前对 Skill 的四个评估视角：A/B 测试、用例分析、触发分析、静态合规。',
  },
  'dim-status': {
    name: '待分析 / 待扫描 / 未配置',
    tag: 'eval',
    body: '维度状态：数据已就绪等待跑分 / 等待静态扫描 / 尚未配置数据集或参数。',
  },
  'weight-excluded': {
    name: '不计入总分',
    tag: 'eval',
    body: '某维度未完成时，其权重从分母中剔除，标注中给出被剔除的权重大小（如 -40%）。',
  },

  // ----- §10.2 A/B 测试 -----
  'ab-test': {
    name: 'A/B 测试',
    tag: 'eval',
    body: '同一份输入分别在"开启 Skill"与"不开启 Skill"两个 Agent 版本下执行，对比效果差异。',
  },
  'control-version': {
    name: '对照版本（A）',
    tag: 'eval',
    body: '不挂载该 Skill 的基线 Agent。',
  },
  'experiment-version': {
    name: '实验版本（B）',
    tag: 'eval',
    body: '挂载了该 Skill 的 Agent。',
  },
  'repeat-rounds': {
    name: '重复轮次',
    tag: 'eval',
    body: '同一样本重复执行的次数，用于计算方差、消除随机性。',
  },
  'auto-eval': {
    name: '自动评测',
    tag: 'eval',
    body: '跑完后自动调用评估器返回准确率与"Skill 是否生效"的判断。',
  },
  'log-skill-trigger': {
    name: '记录 Skill 触发详情',
    tag: 'skill',
    body: '保留每条样本下 Skill 的命中/未命中明细，便于事后定位。',
  },
  'eval-source': {
    name: '从数据集发起 / 从执行链路发起',
    tag: 'eval',
    body: '输入来源：复用既有评测集，或直接选取线上 Trace 作为输入。',
  },

  // ----- §10.3 用例分析 -----
  'case-analysis': {
    name: '用例分析',
    tag: 'eval',
    body: '基于已评测 Trace 的"结果 + 轨迹"双维度回看，定位 Skill 在真实流量中的得失。',
  },
  'result-analysis': {
    name: '结果分析',
    tag: 'eval',
    body: '仅看最终答案是否达成用户目标。',
  },
  'trajectory-analysis': {
    name: '轨迹分析',
    tag: 'eval',
    body: '看中间过程是否按 SKILL.md 期望的步骤进行。',
  },
  'case-set': {
    name: '用例集',
    tag: 'eval',
    body: '当前 Skill 版本关联的 Trace 集合，可勾选送入"触发分析"。',
  },
  'high-divergence': {
    name: '高偏离',
    tag: 'fault',
    body: '实际输出与参考答案差异较大的样本筛选标签。',
  },

  // ----- §10.4 触发分析 -----
  'trigger-analysis': {
    name: '触发分析',
    tag: 'skill',
    body: '评估 Skill 路由是否准确——哪些 query 应命中本 Skill、哪些不应。',
  },
  'trigger-eval-set': {
    name: '触发评价集',
    tag: 'eval',
    body: '专用于触发分析的数据集，每条样本带有"是否应触发"的标注。',
  },
  'trigger-hit-rate': {
    name: '触发集命中率',
    tag: 'metric',
    body: '"应触发且确实触发"的样本占比，越高越好。',
    formula: 'should_trigger ∩ did_trigger / should_trigger',
  },
  'false-trigger-rate': {
    name: '误触发率',
    tag: 'fault',
    body: '"不应触发却触发"的样本占比，越低越好。',
    formula: '¬should_trigger ∩ did_trigger / ¬should_trigger',
  },
  'edge-case': {
    name: '边界用例',
    tag: 'eval',
    body: '处在触发/不触发边界、最容易判错的样本。',
  },
  'ai-draft': {
    name: 'AI 起草',
    tag: 'tool',
    body: '让模型基于现有 Skill 描述自动生成一份触发评价集草稿。',
  },
  'opencode-live': {
    name: 'opencode-live',
    tag: 'metric',
    body: '当前触发分析所使用的线上路由通道名称。',
  },

  // ----- §10.5 静态合规 -----
  'static-compliance': {
    name: '静态合规分析',
    tag: 'eval',
    body: '基于规则的 SKILL.md 文本扫描，不需要实际执行 Skill。',
  },
  'purpose-fit': {
    name: '目的适配性',
    tag: 'eval',
    body: 'Skill 是否有清晰的单一目的，便于 LLM 准确识别调用时机。',
  },
  'structure-norm': {
    name: '结构规范性',
    tag: 'eval',
    body: 'SKILL.md 的元数据规范、内容组织和信息密度。',
  },
  'instruction-fit': {
    name: '指令适配性',
    tag: 'eval',
    body: '指令自由度与任务风险等级、确定性是否匹配。',
  },
  'content-consistency': {
    name: '内容一致性',
    tag: 'eval',
    body: '术语和表达风格是否前后一致，是否依赖隐含的时效性假设。',
  },
  'ops-reliability': {
    name: '运维可靠性',
    tag: 'eval',
    body: '安全边界、灾难恢复路径与可观测性。',
  },
  'script-quality': {
    name: '脚本及参考文档质量',
    tag: 'eval',
    body: '配套脚本与参考资料的独立性、健壮性与自愈能力。',
  },

  // ===== §11 Skill 优化 =====
  'skill-optimization': {
    name: 'Skill 优化',
    tag: 'skill',
    body: '基于分析结果，对 SKILL.md 与配套脚本/参考资料进行版本迭代。',
  },
  'current-version': {
    name: '当前版本',
    tag: 'skill',
    body: '正在被引用的激活版本，作为优化的基线（如 v0 当前）。',
  },

  // ===== §12 配置 =====
  'model-registry': {
    name: '模型注册',
    tag: 'tool',
    body: '录入外部模型（如 DeepSeek、OpenAI 等）的密钥与 endpoint，供 Agent / 评估器调用。',
  },
  'install-guide': {
    name: '安装指导',
    tag: 'tool',
    body: '现有 Agent 接入本平台的 SDK 与配置文档入口。',
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof GLOSSARY;

export function getTermById(id: string): GlossaryEntry | undefined {
  return (GLOSSARY as Record<string, GlossaryEntry>)[id];
}

export function getAllTermIds(): string[] {
  return Object.keys(GLOSSARY);
}
