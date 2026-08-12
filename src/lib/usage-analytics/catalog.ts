import type { EffectiveUseDefinition, UsageFeatureDefinition } from './types';

// 有效使用口径的唯一真源：服务端校验白名单、客户端上报白名单、功能排行与详情标签都从这里派生。
// 只有定义了至少一个 uses 的功能才进入排行 —— Workspace 总览没有有效使用行为，显式不在表中。
const s = (key: string, label: string, countWhen: string): EffectiveUseDefinition => ({
    key,
    label,
    source: 'server',
    countWhen,
});
const c = (key: string, label: string, countWhen: string): EffectiveUseDefinition => ({
    key,
    label,
    source: 'client',
    countWhen,
});

export const USAGE_FEATURES: UsageFeatureDefinition[] = [
    {
        key: 'agents',
        labelKey: 'nav.agents',
        label: 'Agent 概览',
        // 设计文档里的 agent.register / agent.sync 在当前代码中没有对应的用户操作入口：
        // /api/agents 只有 GET，其中的 registeredAgent.create 是列表查询时的后台自动推断，
        // 按"后台自动同步不计"的口径不能埋点。将来加了主动注册/同步按钮再补回来。
        uses: [s('agent.delete', '删除 Agent', 'DELETE /api/agents/[id] 成功返回')],
    },
    {
        key: 'trace',
        labelKey: 'nav.trace',
        label: '链路追踪',
        uses: [
            c('trace.detail.view', '查看 Trace 详情', '选中 Trace 且详情首次加载成功；同一次打开记 1 次'),
            s('trace.export', '导出 Trace', '/api/observe/traces/export 成功生成下载响应'),
            s('trace.import', '导入 Trace', '/api/observe/traces/import 成功完成一次导入'),
            s('trace.backflow', '回流到评测数据集', '/api/agent-datasets/backflow 成功完成一次回流'),
            s('trace.delete', '删除 Trace', 'DELETE /api/observe/data 成功删除'),
            s('trace.update', '编辑 Trace 信息', 'PATCH /api/observe/data 成功保存（标注/备注/标题等）'),
            s('trace.tag.bind', '绑定标签到 Trace', 'POST/PUT /api/observe/executions/[id]/tags 成功'),
            s('trace.tag.unbind', '解绑 Trace 标签', 'DELETE /api/observe/executions/[id]/tags 成功'),
            s('trace.draft.save', '存为数据集草稿', 'POST /api/agent-datasets/trace-drafts 成功'),
            s('trace.agent.debug', '发起 Agent 调试分析', 'POST /api/observe/executions/[id]/agent-debug 成功创建任务'),
        ],
    },
    {
        key: 'version-analysis',
        labelKey: 'nav.versionAnalysis',
        label: '版本分析',
        uses: [
            c('version.compare', '发起版本对比', '用户改变有效对比条件并成功获得 compare 结果；初始化自动加载不计'),
        ],
    },
    {
        key: 'fault',
        labelKey: 'nav.fault',
        label: '诊断分析',
        uses: [
            c('fault.history.view', '查看已诊断历史', '用户主动选择历史记录且详情成功加载；列表轮询不计'),
            s('fault.diagnosis.run', '启动诊断', '/api/fault/diagnosis/stream 成功创建诊断任务'),
            s('fault.message.send', '继续诊断对话', '用户消息被服务端接受；流式 token 不重复计'),
        ],
    },
    {
        key: 'infra',
        labelKey: 'nav.infra',
        label: '推理基础设施',
        // Infra 的接口不带 user，页面也没有 auth context（见 (main)/infra/*），
        // 服务端无从归属身份，因此这三项在客户端成功后上报。
        uses: [
            c('infra.diagnose', '启动 Infra 诊断', '诊断请求成功返回结果'),
            c('infra.source.save', '保存指标源', '/api/observe/infra/sources 保存成功'),
            c('infra.source.test', '测试指标源连接', '/api/observe/infra/sources/test 完成一次主动测试'),
        ],
    },
    {
        key: 'experiments',
        labelKey: 'nav.experiments',
        label: '实验',
        uses: [
            s('experiment.run', '运行实验', '/api/experiments/[id]/run 成功创建整次实验；不按 case 重复'),
            s('experiment.retry', '重试单条结果', 'retry API 成功接受一次用户重试'),
            s('experiment.case.create', '新增用例', '/api/experiments/[id]/cases 创建成功'),
            s('experiment.case.update', '编辑用例', '用例保存成功；输入过程不计'),
            s('experiment.create', '创建实验', 'POST /api/experiments 成功创建'),
            s('experiment.watch.stop', '停止监听模式', 'PATCH /api/experiments/[id] watchMode:false 成功'),
        ],
    },
    {
        key: 'dataset',
        labelKey: 'nav.evalDataset',
        label: '数据集',
        uses: [
            s('dataset.create', '创建数据集', 'POST /api/agent-datasets 成功'),
            // 与「编辑样本」共用 PATCH 接口，服务端无从区分，故在只有导入会走到的分支上客户端上报
            c('dataset.import', '导入数据', '一次批量导入成功完成，不按样本数重复'),
            s('dataset.sample.update', '编辑样本', '单次保存成功'),
            s('dataset.backflow', 'Trace 回流', '/api/agent-datasets/backflow 一次请求成功'),
            s('dataset.delete', '删除数据集', 'DELETE /api/agent-datasets/[id] 成功'),
        ],
    },
    {
        key: 'metrics',
        labelKey: 'nav.evalMetrics',
        label: '评估指标',
        uses: [
            s('evaluator.save', '创建或修改评估器', '保存 API 成功'),
            s('evaluator.delete', '删除评估器', '删除 API 成功'),
        ],
    },
    {
        // skillsmgr 菜单 key 对外统计固定为 skill —— Phase2 §4 要求的显式映射。
        key: 'skill',
        labelKey: 'nav.skillsManage',
        label: 'Skill 管理',
        uses: [
            s('skill.download', '下载 Skill 版本', '/api/skills/[id]/versions/[version]/download 成功返回文件'),
            s('skill.upload', '上传 Skill', '/api/skills/upload 成功'),
            s('skill.publish', '发布 Skill', '/api/skills/publish 成功'),
            s('skill.activate', '切换活跃版本', '/api/skills/[id]/activate 成功'),
            s('skill.delete', '删除 Skill 版本', 'DELETE /api/skills/[id]/versions/[version] 成功'),
            s('skill.remove', '删除 Skill', 'DELETE /api/skills 成功删除整个 Skill'),
        ],
    },
    {
        key: 'skill-generator',
        labelKey: 'nav.skillGenerator',
        label: 'Skill 生成',
        uses: [
            s('skill.generate.run', '提交生成请求', '/api/skill-generator/chat 成功接受首个生成请求'),
            s('skill.generate.message', '继续生成对话', '后续用户消息成功接受；流式 token 不计'),
            s('skill.generate.download', '下载生成结果', '下载 API 成功返回文件'),
            s('skill.generate.session.delete', '删除生成会话', 'DELETE /api/skill-generator/sessions/[id] 成功'),
        ],
    },
    {
        key: 'skill-eval',
        labelKey: 'nav.skillEval',
        label: 'Skill 评测',
        uses: [
            s('skill.eval.case.run', '运行用例评测', '一次评测任务成功创建'),
            s('skill.eval.static.run', '运行静态评测', '一次静态评测成功创建'),
            s('skill.eval.trigger.run', '运行触发评测', '/api/skill-eval/trigger/[skillName]/run 成功创建任务'),
            s('skill.eval.ab.run', '启动 A/B 测试', '一次 A/B 任务成功创建'),
            s('skill.eval.debug.run', '运行调试执行', 'POST /api/debug/execute 成功创建任务'),
            s('skill.eval.trigger.save', '保存触发评测集', 'POST /api/skill-eval/trigger/[skillName] 成功保存'),
        ],
    },
    {
        key: 'skill-opt',
        labelKey: 'nav.skillOpt',
        label: 'Skill 优化',
        uses: [
            s('skill.optimize.run', '发起优化', '/api/skill-opt/chat 成功接受优化请求'),
            s('skill.draft.apply', '应用优化草稿', 'apply API 成功'),
            s('skill.plan.confirm', '确认优化计划', 'plan API 成功保存确认'),
            s('skill.optimize.session.delete', '删除优化会话', 'DELETE /api/skill-opt/sessions/[id] 成功'),
        ],
    },
    {
        key: 'model-registry',
        labelKey: 'nav.modelRegistry',
        label: '模型注册',
        uses: [
            s('model.save', '保存模型配置', '模型配置保存成功'),
            s('model.test', '测试模型连接', '主动测试完成；页面健康轮询不计'),
            s('model.pricing.save', '保存模型单价', 'PUT /api/modelconfig/pricing 成功'),
        ],
    },
    {
        key: 'web-search',
        labelKey: 'nav.webSearch',
        label: '联网搜索',
        // 联网搜索页当前只有「保存」一个按钮，没有连接测试入口，
        // 因此设计文档里的 websearch.test 暂不纳入。
        uses: [s('websearch.save', '保存搜索配置', '配置保存成功')],
    },
    {
        key: 'version-management',
        labelKey: 'nav.versionManagement',
        label: '版本管理',
        uses: [
            s('version.tag.create', '创建版本标签', 'POST /api/tags 成功且 kind=version'),
            s('version.tag.update', '编辑版本标签', 'PUT /api/tags/[id] 成功且目标为版本标签'),
            s('version.tag.delete', '删除版本标签', 'DELETE /api/tags/[id] 成功且目标为版本标签'),
        ],
    },
    {
        key: 'access-install',
        labelKey: 'nav.accessInstall',
        label: '客户端安装',
        uses: [
            // 接入命令是页面本地拼出来的，没有服务端调用，只能客户端上报
            c('access.config.generate', '生成接入配置', '用户改变接入组件选择并成功重新生成命令'),
            c('access.command.copy', '复制安装命令', 'navigator.clipboard.writeText() Promise 成功'),
        ],
    },
];

/**
 * 显式不统计的菜单叶子：有页面但没有任何"有效使用"行为，不得出现在功能排行中。
 *
 * - dashboard（Workspace 总览）：设计文档明确排除，页面进入不计数。
 * - quality（质量监控）：当前是只读页面，/api/quality 下只有 agents/executions/report
 *   三个 GET；v0.7.1 已移除"质量监控结果评测"。将来加回主动评测再纳入统计。
 */
export const NON_TRACKED_FEATURE_KEYS = ['dashboard', 'quality'] as const;

const FEATURE_BY_KEY = new Map(USAGE_FEATURES.map((f) => [f.key, f]));

const EVENT_INDEX = new Map<string, { feature: UsageFeatureDefinition; use: EffectiveUseDefinition }>();
for (const feature of USAGE_FEATURES) {
    for (const use of feature.uses) {
        EVENT_INDEX.set(use.key, { feature, use });
    }
}

export function listFeatureKeys(): string[] {
    return USAGE_FEATURES.map((f) => f.key);
}

export function getFeature(featureKey: string): UsageFeatureDefinition | undefined {
    return FEATURE_BY_KEY.get(featureKey);
}

export function isTrackedFeature(featureKey: string): boolean {
    return FEATURE_BY_KEY.has(featureKey);
}

export function getFeatureLabel(featureKey: string): string {
    return FEATURE_BY_KEY.get(featureKey)?.label ?? featureKey;
}

export function getEventLabel(eventKey: string): string {
    return EVENT_INDEX.get(eventKey)?.use.label ?? eventKey;
}

/** 事件 key 必须存在，且必须属于声明的 featureKey —— 防止把事件挂到别的功能下。 */
export function isValidEvent(featureKey: string, eventKey: string): boolean {
    const hit = EVENT_INDEX.get(eventKey);
    return !!hit && hit.feature.key === featureKey;
}

/** 客户端只能提交 source='client' 的事件；服务端专属事件不可由浏览器伪造。 */
export function isClientSubmittable(featureKey: string, eventKey: string): boolean {
    const hit = EVENT_INDEX.get(eventKey);
    return !!hit && hit.feature.key === featureKey && hit.use.source === 'client';
}

export function getEventSource(eventKey: string) {
    return EVENT_INDEX.get(eventKey)?.use.source;
}

export function listEventKeys(): string[] {
    return [...EVENT_INDEX.keys()];
}
