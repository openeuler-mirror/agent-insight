"""Build the Chinese comparison report and charts from completed experiment artifacts."""
import argparse
import csv
import gzip
import hashlib
import json
import importlib.metadata
import platform
import pathlib
import shutil

NAMES = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
LABELS = {'NoRobots': 'No Robots', 'ShareGPT4': 'ShareGPT-GPT4', 'SummarizeFeedback': 'Summarize from Feedback'}
MS_URL = 'https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722'
MS_DOC_URL = 'https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/cloud-evaluation-deployed-interactions#intelligent-sampling'
MS_VOCABULARY = {'WildChat': 44.8, 'Dolly': 5.7, 'NoRobots': 44.5, 'OASST2': 55.7, 'ShareGPT4': 86.3, 'UltraChat': 49.3}
MS_QUALITY = {'OASST2': 8.1, 'HelpSteer2': -9.7, 'SummarizeFeedback': 8.3}


def build(results, output, coverage=None):
    reports = {n: json.loads((results / (n + '.json')).read_text()) for n in NAMES}
    assert all(r.get('finishedAt') for r in reports.values()), 'All eight datasets must finish before reporting'
    assert json.loads((results / 'verification.json').read_text()).get('passed'), 'Run audit-eight-datasets.py first'
    output.mkdir(parents=True, exist_ok=True)
    artifacts = output / 'examples' / 'eight-datasets'
    artifacts.mkdir(parents=True, exist_ok=True)
    summary = {}
    csv_rows = []
    primary = []
    for name, report in reports.items():
        summary[name] = {k: v for k, v in report.items() if k != 'experiments'}
        summary[name]['experiments'] = []
        groups = {}
        for experiment in report['experiments']:
            summary[name]['experiments'].append({k: v for k, v in experiment.items() if k not in ('trials', 'poolKeys')})
            if experiment['population'] == 'all':
                groups.setdefault(experiment['stratum'], []).append(experiment)
            for method, metrics in experiment['methods'].items():
                csv_rows.append({'dataset': name, 'stratum': experiment['stratum'], 'population': experiment['population'], 'pool': experiment['actualPairs'], 'inputs': experiment['actualInputs'], 'method': method, 'vocabulary': metrics['vocabulary']['mean'], 'unigram_diversity': metrics['unigramDiversity']['mean'], 'input_chars': metrics['meanInputChars']['mean'], 'prefix256_vocabulary': metrics['vocabularyPrefix256']['mean'], 'known_tasks': metrics['knownTasks']['mean'], 'native_categories': metrics['nativeCategories']['mean'], 'selection_ms': metrics['selectionMs'], 'quality': json.dumps(metrics['quality'])})
        for stratum, experiments in groups.items():
            experiment = min(experiments, key=lambda e: abs(e['requestedPool'] - 5000))
            primary.append((name, stratum, experiment))
        with (artifacts / (name + '.json.gz')).open('wb') as out:
            with gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0) as compressed:
                compressed.write((results / (name + '.json')).read_bytes())
    (artifacts / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    (artifacts / 'data-manifest.json').write_text(json.dumps([r['source'] for r in reports.values()], ensure_ascii=False, indent=2))
    for filename in ('evaluation-plan.json', 'implementation.json'):
        shutil.copyfile(results / filename, artifacts / filename)
    implementation = json.loads((artifacts / 'implementation.json').read_text())
    implementation['reportingFilesRawSha256'] = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path('scripts/trace-datasets/report-eight-datasets.py'), pathlib.Path('scripts/trace-datasets/audit-eight-datasets.py')]}
    implementation['pythonTools'] = {'python': platform.python_version(), **{p: importlib.metadata.version(p) for p in ['requests', 'numpy', 'pyarrow', 'matplotlib']}}
    (artifacts / 'implementation.json').write_text(json.dumps(implementation, indent=2))
    for filename in ('verification.json', 'test-status.json'):
        if (results / filename).exists():
            shutil.copyfile(results / filename, artifacts / filename)
    if not (artifacts / 'test-status.json').exists():
        (artifacts / 'test-status.json').write_text(json.dumps({'status': 'not_recorded_for_this_run'}))
    with (artifacts / 'metrics.csv').open('w', newline='') as out:
        writer = csv.DictWriter(out, fieldnames=csv_rows[0].keys())
        writer.writeheader()
        writer.writerows(csv_rows)

    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
    labels = [LABELS.get(n, n) + (f' {s}' if s != 'all' else '') for n, s, _ in primary]
    y = np.arange(len(labels))
    fig, axes = plt.subplots(1, 2, figsize=(14, 7), sharey=True, layout='constrained')
    for ax, metric, title in zip(axes, ['vocabulary', 'meanInputChars'], ['Vocabulary size vs random (%)', 'Mean input length vs random (%)']):
        for offset, method, color, label in [(-.18, 'B2', '#777777', 'Text-only baseline (approximation)'), (.18, 'B4', '#4f46e5', 'Agent Insight v4 (historical)')]:
            values = [e['comparisons'][method + '-B0'][metric]['relativePercent'] for _, _, e in primary]
            ax.barh(y + offset, values, height=.34, color=color, label=label)
        ax.axvline(0, color='#333333', linewidth=.8)
        ax.set_title(title)
        ax.grid(axis='x', alpha=.2)
        ax.set_axisbelow(True)
    axes[0].set_yticks(y, labels)
    axes[0].invert_yaxis()
    axes[0].legend(loc='lower left', fontsize=8)
    fig.suptitle('Public dataset sampling comparison | K=100 | mean of 5 seeds\nCandidate pool nearest 5,000 per dataset/stratum; identical pools across methods', fontsize=12)
    fig.savefig(artifacts / 'comparison.png', dpi=180)
    fig.savefig(artifacts / 'comparison.svg', metadata={'Date': None})
    plt.close(fig)

    comparable = [(name, e) for name, _, e in primary if name in MS_VOCABULARY]
    ms_comparison_rows = []
    for name, e in comparable:
        m = e['methods']
        ms_comparison_rows.append({
            'dataset': LABELS.get(name, name),
            'microsoft_published_vs_own_random_percent': MS_VOCABULARY[name],
            'local_B2_vs_B0_percent': e['comparisons']['B2-B0']['vocabulary']['relativePercent'],
            'local_B4_vs_B0_percent': e['comparisons']['B4-B0']['vocabulary']['relativePercent'],
            'local_B4_vs_B2_percent': (m['B4']['vocabulary']['mean'] / m['B2']['vocabulary']['mean'] - 1) * 100,
        })
    with (artifacts / 'microsoft-comparison.csv').open('w', newline='') as out:
        writer = csv.DictWriter(out, fieldnames=ms_comparison_rows[0].keys())
        writer.writeheader()
        writer.writerows(ms_comparison_rows)

    y = np.arange(len(comparable))
    fig, axes = plt.subplots(1, 2, figsize=(13, 6.5), sharex=True, sharey=True, layout='constrained')
    for ax, series, title in [
        (axes[0], [(0, 'microsoft_published_vs_own_random_percent', '#64748b', 'Published Microsoft result')], 'Microsoft publication | separate experiment'),
        (axes[1], [(-.18, 'local_B2_vs_B0_percent', '#999999', 'B2: local text-only approximation'), (.18, 'local_B4_vs_B0_percent', '#4f46e5', 'B4: Agent Insight v4 (historical)')], 'Local experiment | same pool for B2 and B4'),
    ]:
        for offset, key, color, label in series:
            values = [row[key] for row in ms_comparison_rows]
            bars = ax.barh(y + offset, values, height=.32, color=color, label=label)
            ax.bar_label(bars, labels=[f'{v:+.1f}%' for v in values], padding=4, fontsize=10)
        ax.axvline(0, color='#333333', linewidth=.8)
        ax.set_xlim(-78, 115)
        ax.set_title(title, fontsize=11)
        ax.set_xlabel('Vocabulary change vs own random baseline (%)')
        ax.grid(axis='x', alpha=.2)
        ax.set_axisbelow(True)
        ax.legend(loc='lower right', fontsize=8)
        ax.set_ylim(len(comparable) - .1, -.6)
    axes[0].set_yticks(y, [row['dataset'] for row in ms_comparison_rows])
    fig.suptitle('Microsoft published results and Agent Insight measurements\nDifferent source snapshots / pools / tokenizers; B2 is NOT an official Microsoft reproduction', fontsize=12)
    fig.savefig(artifacts / 'microsoft-comparison.png', dpi=180)
    fig.savefig(artifacts / 'microsoft-comparison.svg', metadata={'Date': None})
    plt.close(fig)

    def f(value, digits=1):
        return '—' if value is None else f'{value:,.{digits}f}'

    def table(header, rows):
        return '\n'.join(['| ' + ' | '.join(header) + ' |', '| ' + ' | '.join(['---'] * len(header)) + ' |'] + ['| ' + ' | '.join(str(c) for c in row) + ' |' for row in rows])

    def percent(value):
        return f'{value:+.1f}%'

    comparison_rows = [[row['dataset'], *[percent(v) for k, v in row.items() if k != 'dataset']] for row in ms_comparison_rows]

    source_rows = []
    for name, r in reports.items():
        source = r['source']
        all_experiments = [e for e in r['experiments'] if e['population'] == 'all']
        unique_by_stratum = {e['stratum']: e['availablePairs'] for e in all_experiments}
        max_by_stratum = {s: max(e['actualPairs'] for e in all_experiments if e['stratum'] == s) for s in unique_by_stratum}
        source_rows.append([LABELS.get(name, name), f(source['rawRows'], 0), f(source['mappedRows'], 0), '；'.join(f'{s}: {n:,}' for s, n in unique_by_stratum.items()), '；'.join(f'{s}: {n:,}' for s, n in max_by_stratum.items())])
    main_rows, bias_rows = [], []
    for name, stratum, e in primary:
        label = LABELS.get(name, name) + (f' · {stratum}' if stratum != 'all' else '')
        m = e['methods']
        main_rows.append([label, e['actualPairs'], f(m['B0']['vocabulary']['mean']), f(m['B2']['vocabulary']['mean']), f(m['B4']['vocabulary']['mean']), f(e['comparisons']['B4-B0']['vocabulary']['relativePercent']) + '%', f(m['B0']['unigramDiversity']['mean'], 3) + ' → ' + f(m['B4']['unigramDiversity']['mean'], 3)])
        bias_rows.append([label, f(m['B0']['meanInputChars']['mean']) + ' → ' + f(m['B4']['meanInputChars']['mean']), f(m['B0']['vocabularyPrefix256']['mean']) + ' → ' + f(m['B4']['vocabularyPrefix256']['mean']), f(m['B0']['knownTasks']['mean']) + ' → ' + f(m['B4']['knownTasks']['mean']), f(m['B0']['nativeCategories']['mean']) + ' → ' + f(m['B4']['nativeCategories']['mean'])])
    quality_rows, quality_comparison_rows = [], []
    for name, stratum, original in primary:
        key = {'HelpSteer2': 'helpfulness', 'OASST2': 'quality', 'SummarizeFeedback': 'overall'}.get(name)
        if not key:
            continue
        e = original
        if name == 'OASST2':
            e = next(e for e in reports[name]['experiments'] if e['population'] == 'quality-annotated' and e['requestedPool'] == 5000)
        label = LABELS.get(name, name) + (f' · {stratum}' if stratum != 'all' else '')
        m = e['methods']
        delta = e['comparisons']['B4-B0']['quality.' + key]
        quality_rows.append([label, e['actualPairs'], key, f(m['B0']['quality'][key]['mean'], 3), f(m['B2']['quality'][key]['mean'], 3), f(m['B4']['quality'][key]['mean'], 3), f(delta['relativePercent']) + '%', '[' + ', '.join(f(v, 3) for v in delta['seedBootstrap95']) + ']'])
        quality_comparison_rows.append([label, key, percent(MS_QUALITY[name]) if name != 'SummarizeFeedback' else '未单列此分层', percent(e['comparisons']['B2-B0']['quality.' + key]['relativePercent']), percent(delta['relativePercent'])])
    quality_comparison_rows.append(['Summarize from Feedback · 微软总体', 'overall', percent(MS_QUALITY['SummarizeFeedback']), '未合并不同分层', '未合并不同分层'])
    b4_over_b2 = sum(row['local_B4_vs_B2_percent'] > 0 for row in ms_comparison_rows)
    experiments = sum(len(r['experiments']) for r in reports.values())
    trials = sum(len(e['trials']) for r in reports.values() for e in r['experiments'])
    positive = sum(e['comparisons']['B4-B0']['vocabulary']['relativePercent'] > 0 for _, _, e in primary)
    source_links = '\n'.join(f"- [{LABELS.get(name, name)}]({r['source']['source']})：revision `{r['source']['revision']}`；数据卡许可 `{r['source']['license']}`。" for name, r in reports.items())
    report = f'''# 微软公开数据集上的采样策略对比报告

验证日期：2026-10-11。本报告主体保留 **v4 历史基线**；后续 v5 结果单列，避免将旧结果误读为新版效果。已完成微软报告涉及的全部 **8 个数据集**的无 LLM 采样实验；历史 v4 轮次共 {experiments} 个候选池/分层场景、{trials} 个种子试验、{trials * 5} 次方法运行。这里“全部”指八类数据源均已覆盖，不表示下载并评估其全部历史记录。

**历史 v4 策略没有复现微软所报告的普遍词汇量提升。** 在主表的 {len(primary)} 个数据集/原始分层条件中，有 {positive} 个词汇量高于随机采样，其余下降或持平。词汇量、词汇多样性比率、任务类别覆盖和人工评分应分别判断，不能用其中一个指标代替整体效果。

## 先看结果：微软报告提升，本地六个对应数据集均下降

下表将三种结果放在同一行。**微软列来自其公开报告；B2、B4 列来自本次本地实验。B2 不是微软官方实现。** 微软与本地的候选池、数据快照和分词口径未对齐，前三列各自相对所在实验的随机基线计算；最后一列才是本地同池的方法直接对照。微软数字见[原始报告]({MS_URL})。

{table(['数据集', '微软公开：对其随机基线', '本地文本 B2：对 B0', '历史 v4 策略 B4：对 B0', '本地同池：B4 对 B2'], comparison_rows)}

指标为所选输入的**不同词汇总量**，变化率 = `(方法词汇量 / 对照词汇量 − 1) × 100%`。本地六行均为 N=5,000、K=100、五个种子的均值。例如 B4 对 B2 为正，表示增加任务保底后词汇量较本地纯文本方法增加，不代表优于微软。

![微软公开结果与本地结果并排对照](examples/eight-datasets/microsoft-comparison.png)

图中左右两栏共用百分比坐标，但来自不同实验；零线分别表示各自随机采样的结果。HelpSteer2 和 Summarize from Feedback 未在微软该报告中给出对应词汇量增幅，放在下面的人工评分表对照，不补造数值。

**这里能确认两件事：** 本地 B2 也没有出现微软报告的词汇量提升，因此差异不能全部归因于当前策略增加的任务保底；B4 相对 B2 在这六个同池条件中有 {b4_over_b2} 个提高、{len(comparable) - b4_over_b2} 个下降，任务保底对词汇量的影响有正有负。这些数据没有工具行为，行为补选并未参与，不能用它解释本次差异。

## 方法究竟差在哪里

双方共同采用“MinHash 估计文本相似度，再逐个挑选与已选样本距离最大的候选”的路线，且采样过程不调用 LLM。**相同路线不等于相同算法实现。** 微软流程依据[官方说明]({MS_DOC_URL})，参数依据[公开实验报告]({MS_URL})；本地实现见[采样源码](../../../src/lib/trace-datasets/sampling/index.ts)与[实验脚本](../../../scripts/trace-datasets/compare-eight-datasets.ts)。

| 比较项 | 微软公开方法 | 本地文本基线 B2 | Agent Insight 历史 v4 策略 B4 |
| --- | --- | --- | --- |
| 文本表示 | MinHash，128 维；未完整披露分词、shingle 长度与哈希协议 | Unicode 字符 5-gram、128 维；使用当前生产哈希协议 | 与 B2 相同 |
| 选择顺序 | farthest-first；完整起点与同分处理未披露 | 直接进行文本距离选样，使用确定性排序 | 先对已识别任务类各选一条，再进行文本主选与补选 |
| 任务保底 | 公开材料未说明是否采用 | 关闭 | 最多 5 类正则任务保底；unknown 不保底 |
| 工具行为 | 披露有 Trace 信号聚合，未给出独立行为预算细节 | 关闭 | 有真实行为观测时最多预留 20% 名额；本次预算为 0 |
| 参数 | 报告 alpha=0.35，未解释其确切作用 | 无 alpha 对应实现；rho=0 | rho=0.2 是行为名额比例，不能当作微软 alpha |
| 去重与同输入多回答 | 披露精确去重；等价键、回答变体策略未说明 | 按规范化问答精确去重；按输入分组，先一组一条，不足补变体 | 与 B2 相同 |
| 前置处理与验证对象 | 产品流程含硬过滤与聚合；报告主要验证采样步骤 | 本实验映射公开问答，再运行采样；未复现微软 Trace 处理全链路 | 共用 B2 的实验输入；调用当前生产采样器 |

表中的“未披露/未说明”只表示无法从所引公开材料确认，**不表示微软一定没有这项能力**。在本次无工具行为的实验中，B4 相对 B2 的实际变化是任务保底及其引起的后续选样顺序变化；两者共用文本表示、候选池、去重和回答变体规则。

## 人工评分：同样没有复现微软的整体方向

以下仍为各自相对随机基线的变化，使用数据原有人工评分，无 LLM 打分。微软数值来自[公开报告]({MS_URL})。

{table(['数据集及分层', '人工维度', '微软公开：对其随机基线', '本地 B2：对 B0', '历史 B4：对 B0'], quality_comparison_rows)}

OASST2 的微软公开结果上升，本地结果下降；HelpSteer2 两边均下降。本地 OASST2 使用有 quality 标注的子池，不能认定与微软相同。摘要数据的微软总体汇总口径未披露，本地保留 CNN-DM/test、TLDR/valid1、TLDR/valid2 三个原始分层，因此不把微软总体值强行对应到某一个分层。这里只对照结果方向，不据此给双方算法排优劣；分数绝对值与种子区间见后文。

## 实验范围与可比性

对照依据是[微软公开验证报告]({MS_URL})。候选规模取 1,000、5,000、10,000，选取上限 K=100；数据不足时用实际数量，不复制数据或混入其他官方切分凑数。每个场景使用 42、100、101、102、103 五个种子；42 为产品默认种子，其余用于敏感性分析。每个种子重新计算 MinHash 签名，同一输入组共享签名，同一组方法使用完全相同的候选池。

微软披露 128 维签名、alpha=0.35、target=100，但没有给出可核对的完整算法、alpha 定义、tokenizer、样本 ID 与全部数据 revision。本地 B2 只是公开 MinHash/farthest-first 路线的近似基线。表中微软数值是其公开报告值，本地数值是本次运行值，两者不能据此做严格胜负判定。

沿用本特性不依赖 LLM 的范围，本次不运行模型裁判、模型微调或 Azure Foundry 在线服务。公共对话数据没有真实工具行为观测，不能验证行为补选收益。本报告验证问答候选上的采样策略，不覆盖生产 Trace 接入、结构过滤、发布与 Web UI 链路。

## 数据来源与规模

{table(['数据集', '读取原始行', '映射问答行', '去重后可用问答', '实际最大池'], source_rows)}

WildChat 和 UltraChat 从数据查看服务的可访问范围，以固定种子均匀选择 120 个页、每页最多 100 行；属于页抽样，不是逐行独立均匀抽样。UltraChat 查看服务标为 partial，只覆盖其可访问部分。接口不支持可靠固定 revision，已核对获取前后仓库 SHA，并保存每页响应 SHA-256；原始响应缓存才是本次逐字复现依据。

Dolly、No Robots、OASST2、HelpSteer2 使用指定 revision 的完整 train 文件；ShareGPT-GPT4 使用 OpenChat 发布的 `sharegpt_gpt4.json`，是近似同名来源，未混称微软的确切快照。Summarize from Feedback 使用官方五个 axis_evals 文件，保留 CNN-DM/test、TLDR/valid1、TLDR/valid2 三个独立池；不将 comparisons 的二选一偏好当作 overall 评分。

多轮聊天只映射第一对用户/助手消息，OASST2 取根问题的直接助手回答；这是固定的跨数据集实验映射，不代表产品 v4 的所有轮次提取。Dolly 保留 instruction 和 context；摘要输入包含标题与文章。相同问答按产品 NFC/换行规则合并，同输入不同回答保留；同一问答有多个评分时先平均，再按问答计权。空文本排除，质量分数不用于采样。

来源组与相同输入通过连通分组一起保留在候选池中；因此某些实际池略小于设定上限。没有参数训练或开发/验证切分调优，官方摘要切分始终独立。近重复只按产品规则保留，没有额外语义去重；不宣称来源池完全无近重复。

## 对比方法与指标

| 方法 | 定义 |
| --- | --- |
| B0 | 唯一问答对均匀随机，作为主对照 |
| B1 | 输入组均匀随机，每组先一条，不足补回答变体 |
| B2 | 相同生产 MinHash 与输入组，关闭任务保底、关闭行为补选的纯文本 farthest-first |
| B3 | 任务保底加文本主选，行为比例为 0 |
| B4 | 历史生产 `trace-coverage-v4` 策略，rho=0.2 |

全部试验实际运行 B0–B4，并逐次断言 **B3 与 B4 的选中 ID 完全相同**。原因是这些数据没有行为格子，行为预算为 0，并不是行为补选已得到验证。

词汇量为选中输入的不同 token 数；一元词汇多样性为“不同 token 数/总 token 数”。tokenizer 固定为 NFC、小写化、汉字按码点、其他字母/数字按连续词分组，忽略标点；微软未公开完全相同的 tokenizer。短输入通常更容易取得较高比率，所以同时报告输入长度，以及每条仅看前 256 个 token 的词汇量敏感性指标。后者只限制指标观察窗口，不截断供采样的输入，也不等于两组总 token 预算完全相等。

人工评分只使用原生标签：HelpSteer2 helpfulness 为 0–4，OASST2 quality 为 0–1，摘要 overall 为 1–7；不同量纲不合并。摘要原始评分混合数字与数字字符串，已统一解析并核对范围；缺失评分不填零，逐次已标注数量保留在结果中。OASST2 人工质量表使用预先限定的有 quality 标签子池，避免不同缺失率混淆。

## 主对比结果

主表每个分层选择最接近 5,000 的池，均为五个种子的均值，K=100；完整规模与默认 seed=42 单次结果保存在附录文件。

{table(['数据集及分层', '实际 N', '随机词汇量 B0', '文本词汇量 B2', '当前词汇量 B4', 'B4 对 B0', '词汇多样性 B0 → B4'], main_rows)}

![词汇量与输入长度对比](examples/eight-datasets/comparison.png)

## 长度和任务覆盖

{table(['数据集及分层', '平均输入字符 B0 → B4', '前256 token词汇量 B0 → B4', '规则任务类 B0 → B4', '原生类别 B0 → B4'], bias_rows)}

规则任务类别上限为 5，来自生产正则，且是 B4 明确保底的目标，因此其提升主要验证保底行为；不能当作独立语义覆盖证明。原生类别只在数据源提供标签时统计，0 表示没有标签，不表示数据只有零类。固定长度观察下仍存在的词汇量差距，不能仅用总长度差解释；长度偏好是待进一步拆解的机制，而不是已完成因果证明。

## 人工质量评分

{table(['数据集及分层', '实际 N', '人工维度', 'B0', 'B2', 'B4', 'B4 对 B0', '差值的种子区间'], quality_rows)}

区间对五个配对种子做 2,000 次 bootstrap，表示固定候选池下算法种子变化的不确定性，不是数据总体置信区间，也不是原设计中的来源组 bootstrap。种子较少且多个指标同时比较，本报告不声称总体统计显著。人工标签衡量原有回答，不证明用这些样本执行新评测后一定更好。

## 哪些差异已经确认，哪些仍待定位

| 判断 | 本次证据支持程度 |
| --- | --- |
| v4 策略没有复现微软公开的普遍词汇量提升 | 已确认本地结果方向；未完成同数据、同口径的官方算法复现 |
| 任务保底改变选样结果 | 本地 B4/B2 同池对照可检验；词汇量有升有降 |
| 行为补选造成了本次差距 | 不成立：全部运行中 B3 与 B4 入选 ID 相同，行为预算为 0 |
| 选中输入明显变短，与词汇量下降同时出现 | 本地长度表可验证；尚未证明因果关系 |
| 差距主要由字符 5-gram、同分排序、映射或数据池造成 | 待定位；尚未分别控制这些因素，微软对应细节也未全部披露 |
| 当前实现比微软服务差多少 | 不能量化：两边不是同池直接对照，不能把百分比相减当作算法能力差距 |

本次保留全部原始实验结果，未通过换数据、改指标或调参让数字接近微软。

## 结论与后续建议

v4 实现的规则任务保底能够按设计工作，但尚不足以支持“比随机采样全面更优”的表述。使用者如果主要关心输入分布代表性、整体词汇覆盖或高质量参考回答，应分别检视这些指标，不应只看词汇多样性比率。

下一步优先做固定同池的消融：检查距离并列时的选择、短输入偏好、任务保底与输入分组各自的影响，并在独立数据上确认改动。若需要研究微软 alpha 的作用，应先取得其定义或源码。真实工具行为收益需要带工具观测的数据；人工评分下降的数据源需要单独处理答案质量目标。此次实验没有修改生产采样参数。

## 复现与交付文件

- [冻结实验计划](examples/eight-datasets/evaluation-plan.json)、[源码指纹与硬件](examples/eight-datasets/implementation.json)、[数据清单与每文件 SHA](examples/eight-datasets/data-manifest.json)。
- [全部指标汇总](examples/eight-datasets/summary.json)、[本地指标 CSV](examples/eight-datasets/metrics.csv)、[微软与本地对照 CSV](examples/eight-datasets/microsoft-comparison.csv)。
- [微软与本地对照 SVG 图](examples/eight-datasets/microsoft-comparison.svg)、[本地词汇量与长度 SVG 图](examples/eight-datasets/comparison.svg)。
- [独立结果核验](examples/eight-datasets/verification.json)、[测试状态](examples/eight-datasets/test-status.json)。
- 每个数据集的 `.json.gz` 保存原始计数、每个池的候选键、全部方法的入选行 ID、各次耗时与结果，可核对全部 {trials * 5} 次运行。公共数据正文没有复制进仓库。

```sh
# 临时研究工具目录，不修改项目依赖
python3 -m pip install --target /tmp/trace-public-tools requests numpy pyarrow matplotlib
PYTHONPATH=/tmp/trace-public-tools python3 scripts/trace-datasets/fetch-eight-datasets.py /tmp/trace-public-data
node --import tsx scripts/trace-datasets/compare-eight-datasets.ts /tmp/trace-public-data /tmp/trace-public-results
python3 scripts/trace-datasets/audit-eight-datasets.py /tmp/trace-public-data /tmp/trace-public-results > /tmp/trace-public-results/verification.json
PYTHONPATH=/tmp/trace-public-tools python3 scripts/trace-datasets/report-eight-datasets.py /tmp/trace-public-results docs/design/trace-eval-dataset
node --import tsx --test test/trace-datasets-public-experiment.test.ts
```

采样脚本核验映射文件 SHA，拒绝不同实验计划混写，检查入选数、唯一性和候选归属。测试另验证精确去重、回答变体、多评分平均，以及只改变人工评分不会改变入选 ID。来源获取支持已完成文件缓存和限流重试；新下载版本需核对冻结清单，不能默认与本报告相同。精确复现本次公开接口页需要保留本地响应缓存。

时间包含本机并发研究任务的影响；每个 seed 的签名准备在不同 N 的池间共享，`featureMsSharedAcrossPools` 不可对每个池重复累加。`selectionMs` 是对应方法选样耗时，`maxRssKiB` 为该研究进程截至该点的累计峰值，均不等于生产完整生成链路的性能。完整生产压力、Web UI 和平台接入验证不由本实验替代。

## 数据来源索引

{source_links}

摘要轴评分说明见 [OpenAI 原始项目](https://github.com/openai/summarize-from-feedback)。ShareGPT 数据卡未声明独立许可字段；本报告只交付统计和复现标识，不新增原文分发。具体使用条件以对应发布方说明为准。
'''
    if coverage:
        from report_coverage_v5 import build as coverage_report
        overview, section = coverage_report(coverage, output, {
            'url': MS_URL, 'doc_url': MS_DOC_URL, 'vocabulary': MS_VOCABULARY, 'quality': MS_QUALITY,
        })
        title, historical = report.split('\n', 1)
        historical = historical.replace('## 先看结果：', '## 历史 v4 对照：', 1)
        report = title + '\n\n' + overview + section + '## 历史实验范围与补充证据\n' + historical
    destination = output / 'eight-datasets-comparison-report.md'
    destination.write_text(report)
    checksums = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in artifacts.iterdir() if p.is_file() and p.name != 'checksums.json'}
    (artifacts / 'checksums.json').write_text(json.dumps(checksums, indent=2))
    print(json.dumps({'report': str(destination), 'datasets': len(reports), 'experiments': experiments, 'seedTrials': trials, 'methodRuns': trials * 5, 'primaryConditions': len(primary), 'positiveVocabularyConditions': positive}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('results', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--coverage', type=pathlib.Path)
    args = parser.parse_args()
    build(args.results, args.output, args.coverage)
