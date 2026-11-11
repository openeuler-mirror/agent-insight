/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    DEFAULT_THRESHOLDS,
    type DeferralReason,
    type LongTaskReason,
    type TaskCategoryKey,
    type TaskClassification,
    type TaskClassificationInput,
    type TaskInsightThresholds,
} from './types';

interface PatternRule {
    name: string;
    re: RegExp;
    weight: number;
}

interface CategoryRule {
    key: Exclude<TaskCategoryKey, 'other' | 'multi_step_tool'>;
    rules: PatternRule[];
}

/**
 * 规则按「显式内容类型」优先：先看 query 里用户到底要做什么，再看工具调用规模。
 * 权重 = 该信号对分类的置信度；同一类型内多信号累加，避免单个词误判。
 */
const CATEGORY_RULES: CategoryRule[] = [
    {
        key: 'batch',
        rules: [
            { name: '批量', re: /批量|批处理|一次性处理|成批/i, weight: 4 },
            { name: '遍历', re: /遍历|逐个|逐一|挨个|循环处理|for\s+each|each\s+of/i, weight: 3 },
            { name: '所有对象', re: /所有文件|全部文件|所有任务|所有用例|所有仓库|每个文件|每个用例|all\s+files|all\s+tasks/i, weight: 2 },
            { name: 'batch', re: /\bbatch\b|\bbulk\b/i, weight: 4 },
        ],
    },
    {
        key: 'code',
        rules: [
            { name: '代码', re: /代码|源码|编程|程序实现/i, weight: 4 },
            { name: '缺陷/调试', re: /\bbug\b|报错|异常堆栈|修复|调试|断点|栈溢出|stack\s*trace/i, weight: 3 },
            { name: '工程动作', re: /编译|构建|部署|重构|单元测试|集成测试|回归测试|代码审查|\bci\b/i, weight: 3 },
            { name: '脚本', re: /脚本|shell|bash|python|typescript|javascript|\bjava\b|\bgolang\b|\brust\b|c\+\+|react|node\.?js/i, weight: 3 },
            { name: '仓库/接口', re: /\brepo\b|repository|\bgit\b|\bcommit\b|\bmerge\b|\bsql\b|\bapi\b|接口实现|函数实现|类实现/i, weight: 1 },
            { name: '容器', re: /docker|kubernetes|\bk8s\b|容器镜像/i, weight: 2 },
        ],
    },
    {
        key: 'document',
        rules: [
            { name: '文档/附件', re: /文档|附件|\bpdf\b|\bword\b|\bppt\b|\bexcel\b|表格|报告|论文|合同|财报|会议纪要/i, weight: 3 },
            { name: '提取/总结', re: /总结|摘要|提炼|提取|归纳|解析|解读|分析报告|summari[sz]e|summary|extract/i, weight: 3 },
            { name: '数据分析', re: /数据分析|统计分析|数据清洗|分析数据|指标分析|趋势分析/i, weight: 3 },
            { name: '文件', re: /文件|长文本|全文|章节|段落/i, weight: 1 },
            { name: '分析', re: /分析|对比|比较|核对|审查/i, weight: 1 },
            { name: 'document', re: /document|report|paper|spreadsheet|presentation/i, weight: 3 },
        ],
    },
    {
        key: 'text',
        rules: [
            { name: '翻译', re: /翻译|中译英|英译中|translate|translation/i, weight: 5 },
            { name: '改写/润色', re: /改写|重写|润色|校对|缩写|扩写|rewrite|polish|proofread/i, weight: 4 },
            { name: '文案', re: /文案|措辞|语气|标题|宣传语|copywriting|wording|tone/i, weight: 2 },
            { name: '格式变换', re: /格式化|排版|标点|错别字|format(?:ting)?/i, weight: 2 },
        ],
    },
    {
        key: 'qa',
        rules: [
            { name: '疑问', re: /为什么|为何|如何|怎么|怎样|是什么|什么是|是否|能否|可不可以|\bwhat\b|\bwhy\b|\bhow\b|\bwhether\b/i, weight: 2 },
            { name: '解释/建议', re: /介绍|解释|说明一下|区别|差异|推荐|建议|explain|difference|recommend/i, weight: 2 },
            { name: '对比', re: /对比|比较|compare/i, weight: 1 },
        ],
    },
];

/** 多步工具任务的行为信号；仅在内容类型没有明确命中时生效，避免把代码/文档任务误归为工具任务。 */
const MULTI_STEP_KEYWORD_RULES: PatternRule[] = [
    { name: '搜索/检索', re: /搜索|检索|查找|查一下|查询|search|look\s*up|find/i, weight: 2 },
    { name: '浏览/抓取', re: /浏览|打开网页|抓取|爬取|下载|browse|fetch|scrape|download/i, weight: 2 },
    { name: '外部动作', re: /调用接口|执行命令|运行命令|发送邮件|发邮件|提交表单|call\s+api|run\s+command|send\s+email/i, weight: 2 },
];

const URGENCY_RE = /立即|马上|现在就要|现在需要|立刻|紧急|尽快|今天必须|今天就|实时|asap|urgent|immediately|right\s+now/i;
const DEFER_RE = /晚上|夜间|稍后|晚点|回头|有空|不急|明天|后台|异步|定时|夜间执行|overnight|tonight|later|async|background|scheduled?/i;

const TIE_ORDER: TaskCategoryKey[] = ['batch', 'code', 'document', 'text', 'qa'];

function normalizeQuery(query?: string | null): string {
    return (query || '').trim().toLowerCase();
}

function scoreRules(rules: PatternRule[], query: string): { score: number; signals: string[] } {
    let score = 0;
    const signals: string[] = [];
    for (const rule of rules) {
        if (rule.re.test(query)) {
            score += rule.weight;
            signals.push(rule.name);
        }
    }
    return { score, signals };
}

function classifyCategory(query: string, input: TaskClassificationInput): { category: TaskCategoryKey; signals: string[] } {
    const scores = new Map<TaskCategoryKey, { score: number; signals: string[] }>();
    for (const rule of CATEGORY_RULES) {
        scores.set(rule.key, scoreRules(rule.rules, query));
    }

    let best: { category: TaskCategoryKey; score: number; signals: string[] } | null = null;
    for (const key of TIE_ORDER) {
        const current = scores.get(key)!;
        if (current.score < 2) continue;
        if (!best || current.score > best.score) {
            best = { category: key, score: current.score, signals: current.signals };
        }
    }
    if (best) return { category: best.category, signals: best.signals };

    let behaviorScore = 0;
    const behaviorSignals: string[] = [];
    const toolCalls = input.toolCallCount ?? 0;
    const llmCalls = input.llmCallCount ?? 0;
    if (toolCalls >= 5) { behaviorScore += 3; behaviorSignals.push('工具调用≥5'); }
    if (llmCalls >= 5) { behaviorScore += 2; behaviorSignals.push('LLM调用≥5'); }
    const keyword = scoreRules(MULTI_STEP_KEYWORD_RULES, query);
    behaviorScore += keyword.score;
    behaviorSignals.push(...keyword.signals);

    if (behaviorScore >= 2) return { category: 'multi_step_tool', signals: behaviorSignals };
    return { category: 'other', signals: [] };
}

function classifyLength(input: TaskClassificationInput, thresholds: TaskInsightThresholds): {
    length: 'long' | 'short';
    reasons: LongTaskReason[];
} {
    const reasons: LongTaskReason[] = [];
    const latency = input.latencyMs ?? 0;
    const tokens = input.tokens ?? 0;
    const tools = input.toolCallCount ?? 0;
    const llmCalls = input.llmCallCount ?? 0;

    if (latency > 0 && latency >= thresholds.longLatencyMs) reasons.push('latency');
    if (tokens > 0 && tokens >= thresholds.longTokens) reasons.push('tokens');
    if (tools > 0 && tools >= thresholds.longToolCalls) reasons.push('tool_calls');
    if (llmCalls > 0 && llmCalls >= thresholds.longLlmCalls) reasons.push('llm_calls');

    return { length: reasons.length > 0 ? 'long' : 'short', reasons };
}

function classifyDeferral(
    query: string,
    length: 'long' | 'short',
): { deferrable: boolean; reason: DeferralReason } {
    if (length === 'short') return { deferrable: false, reason: 'short' };
    if (URGENCY_RE.test(query)) return { deferrable: false, reason: 'urgency' };
    if (DEFER_RE.test(query)) return { deferrable: true, reason: 'explicit_defer' };
    // 长任务默认视为可延后：没有显式实时要求时，放到夜间低峰执行不会改变结果。
    return { deferrable: true, reason: 'long_default' };
}

export function classifyTask(
    input: TaskClassificationInput,
    thresholds: TaskInsightThresholds = DEFAULT_THRESHOLDS,
): TaskClassification {
    const query = normalizeQuery(input.query);
    const { category, signals } = classifyCategory(query, input);
    const { length, reasons } = classifyLength(input, thresholds);
    const { deferrable, reason } = classifyDeferral(query, length);

    return {
        category,
        length,
        longReasons: reasons,
        deferrable,
        deferralReason: reason,
        matchedSignals: [...new Set(signals)].slice(0, 5),
    };
}
