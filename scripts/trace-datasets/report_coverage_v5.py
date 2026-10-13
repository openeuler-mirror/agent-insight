"""Summarize audited v5 candidate runs without changing the frozen v4 evidence."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
import shutil
from statistics import mean

NAMES = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']


def build(results, output, microsoft):
    audit = json.loads((results / 'verification.json').read_text())
    assert audit['passed'] and audit['datasets'] == 8
    reports = {n: json.loads((results / f'{n}.json').read_text()) for n in NAMES}
    assert all(r.get('finishedAt') for r in reports.values())
    artifacts = output / 'examples' / 'coverage-v5'
    artifacts.mkdir(parents=True, exist_ok=True)
    for name in NAMES:
        with (artifacts / f'{name}.json.gz').open('wb') as out:
            with gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0) as compressed:
                compressed.write((results / f'{name}.json').read_bytes())
    for filename in ['plan.json', 'verification.json', 'test-status.json', 'performance-v4.json', 'performance-v5.json']:
        if (results / filename).exists():
            shutil.copyfile(results / filename, artifacts / filename)
    rows, quality, sensitivities, flat = [], [], [], []
    for name, report in reports.items():
        groups = {}
        for trial in report['scenarios']:
            for method, run in trial['methods'].items():
                flat.append(dict(dataset=name, stratum=trial['stratum'], population=trial['population'], k=trial['k'], seed=trial['seed'], method=method, **{k: v for k, v in run['metrics'].items() if k not in ('quality', 'buckets')}, quality=json.dumps(run['metrics']['quality']), selection_ms=run['selectionMs']))
            if trial['k'] == 100:
                groups.setdefault((trial['stratum'], trial['population']), []).append(trial)
            elif trial['population'] == 'all':
                a, b = (trial['methods'][m]['metrics'] for m in ['B0', 'C'])
                sensitivities.append(dict(dataset=name, stratum=trial['stratum'], k=trial['k'], vocabulary_change=100*(b['vocabulary']/a['vocabulary']-1), tokens_change=100*(b['tokens']/a['tokens']-1)))
        for (stratum, population), trials in groups.items():
            assert len(trials) == 5
            methods = {m: {key: mean(t['methods'][m]['metrics'][key] for t in trials) for key in ['vocabulary', 'tokens', 'prefix256', 'meanInputChars']} for m in trials[0]['methods']}
            equal = [r for r in audit['equalBudget'] if (r['dataset'], r['stratum'], r['population'], r['k']) == (name, stratum, population, 100)]
            assert len(equal) == 5
            rows.append(dict(dataset=name, stratum=stratum, population=population, n=trials[0]['n'], methods=methods,
                             equal_budget_gain=100*(mean(r['C'] for r in equal)/mean(r['B0'] for r in equal)-1)))
            axes = trials[0]['methods']['C']['metrics']['quality']
            for axis in axes:
                scores = {m: mean(t['methods'][m]['metrics']['quality'][axis]['mean'] for t in trials) for m in ['B0', 'B4', 'C']}
                quality.append(dict(dataset=name, stratum=stratum, population=population, axis=axis, **scores))
    summary = dict(status='implemented_not_enabled', default_policy='trace-coverage-v4', candidate_policy='trace-coverage-v5', primary=rows, quality=quality, sensitivity=sensitivities)
    (artifacts / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    with (artifacts / 'metrics.csv').open('w', newline='') as out:
        writer = csv.DictWriter(out, fieldnames=flat[0].keys()); writer.writeheader(); writer.writerows(flat)
    sources = ['src/lib/trace-datasets/sampling/index.ts', 'src/server/trace-datasets/worker.ts', 'scripts/trace-datasets/compare-coverage-v5.ts', 'scripts/trace-datasets/audit-coverage-v5.ts', 'scripts/trace-datasets/report_coverage_v5.py']
    fingerprints = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in sources}
    assert all(r['codeSha256'] == fingerprints[sources[0]] and r['runnerSha256'] == fingerprints[sources[2]] for r in reports.values()), 'Reports must match the final sampler and runner'
    (artifacts / 'implementation.json').write_text(json.dumps(fingerprints, indent=2))
    primary = [r for r in rows if r['population'] == 'all']
    def label(r):
        return r['dataset'] + ((' · '+r['stratum']) if r['stratum'] != 'all' else '')
    def change(r, method, metric='vocabulary'):
        return 100*(r['methods'][method][metric]/r['methods']['B0'][metric]-1)
    def table(headers, values):
        return '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str, row))+' |' for row in values])
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
    y = np.arange(len(primary))
    fig, axes = plt.subplots(1, 2, figsize=(14, 7), sharey=True, layout='constrained')
    for offset, method, color, title in [(-.18, 'B4', '#64748b', 'v4 (default)'), (.18, 'C', '#4f46e5', 'v5 (candidate, disabled)')]:
        for ax, metric in zip(axes, ['vocabulary', 'tokens']):
            values = [change(r, method, metric) for r in primary]
            bars = ax.barh(y+offset, values, height=.34, color=color, label=title)
            ax.bar_label(bars, labels=[f'{v:+.1f}%' for v in values], padding=3, fontsize=8)
    for ax, title in zip(axes, ['Distinct input vocabulary vs random (%)', 'Total input lexical tokens vs random (%)']):
        ax.set_title(title); ax.axvline(0, color='#333333', linewidth=.8); ax.grid(axis='x', alpha=.2); ax.set_axisbelow(True); ax.margins(x=.17)
    axes[0].set_yticks(y, [label(r) for r in primary]); axes[0].invert_yaxis(); axes[0].legend(loc='lower left', fontsize=8)
    fig.suptitle('Same frozen pools | K=100 | 5 seeds | No LLM\nCoverage improves; human quality gate FAILED; production default remains v4', fontsize=12)
    fig.savefig(artifacts / 'comparison.png', dpi=170); fig.savefig(artifacts / 'comparison.svg', metadata={'Date': None}); plt.close(fig)
    main_table = table(['数据及原始分层', 'v4 词汇量对随机', 'v5 词汇量对随机', '同 token 预算：v5 对随机', 'v5 输入 token 对随机'], [[label(r), f"{change(r,'B4'):+.1f}%", f"{change(r,'C'):+.1f}%", f"{r['equal_budget_gain']:+.1f}%", f"{change(r,'C','tokens'):+.1f}%"] for r in primary])
    selected_quality = [r for r in quality if (r['dataset']=='OASST2' and r['population']=='quality-annotated' and r['axis']=='quality') or (r['dataset']=='HelpSteer2' and r['axis'] in ['helpfulness','correctness','coherence']) or (r['dataset']=='SummarizeFeedback' and r['axis'] in ['overall','accuracy','coverage','coherence'])]
    quality_table = table(['数据及分层 / 人工维度', '随机 B0', '默认 v4', '候选 v5', 'v5 − v4'], [[label(r)+' / '+r['axis'], *[f"{r[k]:.3f}" for k in ['B0','B4','C']], f"{r['C']-r['B4']:+.3f}"] for r in selected_quality])
    ablation_table = table(['数据及分层', 'A 词汇量', 'B 词汇量', 'B 输入 token', 'C 词汇量', 'C 输入 token'], [[label(r), f"{change(r,'A'):+.1f}%", f"{change(r,'B'):+.1f}%", f"{change(r,'B','tokens'):+.1f}%", f"{change(r,'C'):+.1f}%", f"{change(r,'C','tokens'):+.1f}%"] for r in primary])
    negative = [r for r in sensitivities if r['vocabulary_change'] <= 0]
    sensitive_table = table(['数据及分层', 'K（仅 seed=42）', 'v5 词汇量对随机', 'v5 token 对随机'], [[label(r), r['k'], f"{r['vocabulary_change']:+.1f}%", f"{r['tokens_change']:+.1f}%"] for r in sensitivities])
    section = f'''## v5 候选算法：已完成，暂不启用

**普通生成仍使用 v4。** v5 在长度配额和档内 token 预算内优先选取能增加新词项的输入，同分时用 MinHash 距离；任务保底、真实行为补选与回答变体仍保留。词项仅在生成时计算，不依赖 LLM，不新增 Trace 存储字段。人工评分仅用于验证，没有用于选样。

此次共 8 个数据源、77 个种子/K/分层场景。主比较沿用旧报告最接近 N=5,000 的相同冻结候选池，K=100、五种子；摘要三个原始分层分别统计，OASST2 有评分子池另算。**下表 10 个主条件词汇量均提高，但 HelpSteer2 helpfulness 从 v4 的 2.898 降至 2.700，未通过质量门槛。按用户选择保留旧默认。** 覆盖收益不能当作参考回答质量收益。

{main_table}

![默认 v4 与候选 v5 的词汇覆盖、长度对照](examples/coverage-v5/comparison.png)

变化率均为五种子均值之比。词汇是输入里的不同词项数；token 是本实验词法切分数量，**不是模型计费 token**。同 token 预算列取每次 B0、C 的较小输入 token 总量，按固定哈希顺序读取输入，最后一条只在指标计算中截断；生成内容保持原文。它用于检查收益是否仅来自更多文字，不是语义覆盖证明。

### 质量门槛为什么未通过

{quality_table}

保留原始人工量纲；OASST2 仅此处采用有质量标注的子池。摘要结果分维度有升有降，TLDR/valid2 的 overall 也低于随机。没有统一总分或事后择优汇总。尚无独立确认集与真实工具行为收益证据，不能宣称新算法全面优于旧版或微软方法。

### 消融与小样本边界

下表为词汇量及输入 token 相对同池随机 B0 的变化。A 仅开启长度/预算约束，B 仅开启词项覆盖，C 两项都开启；三者共用 v5 的任务保底、行为顺序和确定性排序，因此不是把 A 或 B 单独加到 v4 的严格单因素实验。

{ablation_table}

K=20/500 只跑 seed=42，以下完整列出；其中 {len(negative)} 个条件词汇量未超过随机。这些敏感性结果不能替代五种子主结果，也不保证小样本必然改善。

{sensitive_table}

### 实现、验证与复现

- 默认 `POLICY=LEGACY_POLICY`；显式 `COVERAGE_POLICY` 才运行 v5。创建 API 不提供版本开关，旧任务按保存版本运行。Worker 两版均支持。
- [独立审计](examples/coverage-v5/verification.json)核验 67,100 个入选项、855 个人工均值及来源摘要；v4 的 K=100 入选 ID 与历史记录逐项一致。
- [专项与全仓测试状态](examples/coverage-v5/test-status.json)、[最终源码指纹](examples/coverage-v5/implementation.json)、[全部指标 CSV](examples/coverage-v5/metrics.csv)、[汇总](examples/coverage-v5/summary.json)。各数据源压缩 JSON 保留每次入选 ID、指标及运行指纹，未复制公开数据正文。
- 算法交付时专项 23/23 通过，类型检查通过；该轮全仓 3,520 项中 126 项失败（此前基线 123 项，新增 3 项单独复测通过），不能声称全仓通过。
- [实际 Web UI 回归](examples/coverage-v5/default-ui-verification.json)通过：完整 Next.js 认证/API/SQLite/Worker，默认 v4；3 条合成 WorkBuddy Trace、5 条候选，K=2/K=20 分别生成 2/5 条，入选 ID、参考回答、筛选明细及详情页通过；无页面/控制台错误。[发布截图](examples/coverage-v5/default-ui-published-2.png)、[边界截图](examples/coverage-v5/default-ui-published-20.png)。v5 通过显式 Worker 集成测试；当前用户界面没有 v5 开关。
- [v4 合成性能](examples/coverage-v5/performance-v4.json)与[v5 合成性能](examples/coverage-v5/performance-v5.json)：N=10,000、K=500，选样约 4.63 秒 → 6.88 秒，测量点 RSS 约 181 → 208 MiB。只验证合成量级可运行；并发本机负载影响耗时，不能推导生产 SLA。

```sh
node --import tsx scripts/trace-datasets/compare-coverage-v5.ts /tmp/trace-public-data /tmp/trace-public-results /tmp/trace-v5-results
node --import tsx scripts/trace-datasets/audit-coverage-v5.ts /tmp/trace-public-data /tmp/trace-public-results /tmp/trace-v5-results
PYTHONPATH=/tmp/trace-public-tools python3 scripts/trace-datasets/report-eight-datasets.py /tmp/trace-public-results docs/design/trace-eval-dataset --coverage /tmp/trace-v5-results
```

这些数据在设计改进前已经看过，属于**已知回归集**。探索运行发现长文本偏移后增加了档内 token 预算，随后冻结最终实现重跑；本报告未将调参数据包装为独立验证。微软公开数字与本地数据快照、池及分词仍不一致，下面的历史微软对照保持原口径。

'''
    microsoft_rows = []
    for name, published in microsoft['vocabulary'].items():
        row = next(r for r in primary if r['dataset'] == name and r['stratum'] == 'all')
        v4, v5 = change(row, 'B4'), change(row, 'C')
        microsoft_rows.append(dict(dataset=name, microsoft_published_percent=published, local_v4_percent=v4, local_v5_percent=v5, displayed_gain_difference_pp=v5-published))
    with (artifacts / 'microsoft-v4-v5.csv').open('w', newline='') as out:
        writer = csv.DictWriter(out, fieldnames=microsoft_rows[0].keys()); writer.writeheader(); writer.writerows(microsoft_rows)
    direct_table = table(['数据集', '微软公开', '默认 v4', '候选 v5', 'v5 − 微软公开值（百分点）'], [[r['dataset'], *[f"{r[k]:+.1f}%" for k in ['microsoft_published_percent','local_v4_percent','local_v5_percent']], f"{r['displayed_gain_difference_pp']:+.1f}"] for r in microsoft_rows])
    from matplotlib import font_manager
    font_paths = [Path('/mnt/c/Windows/Fonts/msyh.ttc'), Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')]
    font_path = next((p for p in font_paths if p.exists()), None)
    chinese = font_path is not None
    if chinese:
        font_manager.fontManager.addfont(str(font_path))
    chart_font = font_manager.FontProperties(fname=str(font_path)).get_name() if chinese else 'DejaVu Sans'
    with plt.rc_context({'font.family': chart_font, 'axes.unicode_minus': False}):
        y = np.arange(len(microsoft_rows))
        fig, ax = plt.subplots(figsize=(12, 6.5), layout='constrained')
        series = [(-.25, 'microsoft_published_percent', '#c4c4c4', '微软公开（独立实验）' if chinese else 'Microsoft publication (separate experiment)', '//'), (0, 'local_v4_percent', '#64748b', 'Agent Insight v4（默认）' if chinese else 'Agent Insight v4 (default)', ''), (.25, 'local_v5_percent', '#4f46e5', 'Agent Insight v5（候选，未启用）' if chinese else 'Agent Insight v5 (candidate, disabled)', '')]
        for offset, key, color, title, hatch in series:
            values = [r[key] for r in microsoft_rows]
            bars = ax.barh(y+offset, values, height=.22, color=color, label=title, hatch=hatch, edgecolor='#555555' if hatch else color, linewidth=.4)
            ax.bar_label(bars, labels=[f'{v:+.1f}%' for v in values], padding=4, fontsize=10)
        ax.set_yticks(y, [r['dataset'] for r in microsoft_rows]); ax.invert_yaxis(); ax.axvline(0, color='#333333', linewidth=.8)
        ax.set_xlim(-72, 112); ax.grid(axis='x', alpha=.2); ax.set_axisbelow(True)
        ax.set_xlabel('所选输入的不同词汇量，相对各自随机基线的变化（%）' if chinese else 'Distinct input vocabulary change vs each experiment\'s own random baseline (%)')
        ax.set_title('微软公开结果、默认 v4 与候选 v5：六个数据集逐项对照\n微软与本地候选池／数据快照／分词不同；数值并列不代表同池胜负' if chinese else 'Microsoft vs v4 vs v5 | Six datasets\nDifferent Microsoft/local pools, snapshots and tokenizers; not a head-to-head benchmark', fontsize=13, pad=15)
        ax.legend(loc='lower right', fontsize=9)
        fig.savefig(artifacts / 'microsoft-v4-v5.png', dpi=170)
        fig.savefig(artifacts / 'microsoft-v4-v5.svg', metadata={'Date': None})
        plt.close(fig)
    human_rows = []
    for name, axis in [('OASST2','quality'), ('HelpSteer2','helpfulness')]:
        q = next(r for r in quality if r['dataset']==name and r['axis']==axis and (name!='OASST2' or r['population']=='quality-annotated'))
        human_rows.append([name+' / '+axis, f"{microsoft['quality'][name]:+.1f}%", f"{100*(q['B4']/q['B0']-1):+.1f}%", f"{100*(q['C']/q['B0']-1):+.1f}%"])
    human_rows.append(['摘要 / overall（微软总体）', f"{microsoft['quality']['SummarizeFeedback']:+.1f}%", '未合并原始分层', '未合并原始分层'])
    for q in quality:
        if q['dataset']=='SummarizeFeedback' and q['axis']=='overall':
            human_rows.append(['摘要 / '+q['stratum'], '未单列该分层', f"{100*(q['B4']/q['B0']-1):+.1f}%", f"{100*(q['C']/q['B0']-1):+.1f}%"])
    direct_quality = table(['数据 / 人工评分', '微软公开', '默认 v4', '候选 v5'], human_rows)
    overview = f'''## 微软、当前默认和候选新版，差异直接对照

**当前默认仍为 v4，v5 已实现但未启用。** 微软公开方法和 v4 都以文本距离选样；v5 改为在长度约束内优先增加新词项，文本距离退到同分时使用。下面先看结果差异，再看算法和验证范围差异。

### 词汇覆盖：三方放在同一行

每列都是“所选输入的不同词汇总量，相对该实验随机采样的增幅”。微软来自[公开报告]({microsoft['url']})；本地 v4、v5 使用相同冻结池、K=100、五种子。**微软与本地不是同一个实验，最后一列仅为增幅的数值相减，不是算法性能差距。**

{direct_table}

![微软公开、默认 v4、候选 v5 的六数据集直接对照](examples/coverage-v5/microsoft-v4-v5.png)

读表例子：WildChat 的微软公开增幅为 +44.8%，本地 v4 为 −52.2%，v5 为 +60.3%；v5 与微软公开数值相差 +15.5 个百分点。OASST2 则分别为 +55.7%、−22.3%、+16.0%，v5 的公开数值对照低 39.7 个百分点。**v5 在六个数据集上均高于本地随机；与微软公开增幅相比，数值上两项较高、四项较低。不能据此认定 v5 胜过或落后微软算法。**

### 人工评分：覆盖改善是否伴随质量改善

下表仍是人工评分均值相对各自随机基线的变化。微软数据来自同一[公开报告]({microsoft['url']})。OASST2 本地只用有 quality 标注的子池；摘要保留原始分层，不把微软总体值填到各分层。

{direct_quality}

**OASST2：微软报告评分上升，本地 v5 仍略低于随机。HelpSteer2：两边均下降；本地 v5 也低于默认 v4。** 因此，本地词汇覆盖提升并未复现微软在各质量数据集上的整体结果；当前仍保留旧默认。HelpSteer2 的绝对均值为随机 2.928、v4 2.898、v5 2.700。

### 算法：v5 的选样目标已经不同

| 对照项 | 微软公开方法 | Agent Insight v4（默认） | Agent Insight v5（候选） |
| --- | --- | --- | --- |
| 每次优先选择什么 | 到最近已选样本的距离最大：MinHash farthest-first | 任务保底后，以最小文本距离最大化为主 | 在可用长度配额/预算内，新增未覆盖词项最多的输入 |
| MinHash 的作用 | 核心选择依据；128 维 | 核心文本选择依据；128 维、字符 5-gram | 覆盖增量相同时用于比较；签名协议沿用 v4 |
| 长度控制 | 所引公开材料未给出对应机制 | 无长度分档配额 | 四个长度档＋按输入组比例分配名额＋档内 token 预算 |
| 任务和工具行为 | 披露 Trace 信号聚合；未给出独立预算细节 | 规则任务保底，文本主选后补真实工具行为 | 任务保底后先补真实行为，再做长度约束下的覆盖主选 |
| 采样是否依赖 LLM | 否 | 否 | 否；词项在生成时临时计算 |
| 参数能否直接对应 | num_perm=128、alpha=0.35、target=100；alpha 含义未披露 | rho=0.2 表示行为名额比例 | 沿用 rho；它与微软 alpha 不是同一个已知参数 |

微软流程依据[官方说明]({microsoft['doc_url']})及公开报告；“未披露”不表示微软没有该机制。本地两版见[采样源码](../../../src/lib/trace-datasets/sampling/index.ts)。**目前没有微软官方实现的同池运行结果；附录 B2 是本地文本近似基线，不能当成微软本身。**

从优化目标看，文本之间很不相似，不等于它们合起来包含的词汇最多。v5 直接优化新增词项数量，因此更贴近本报告的词汇指标；两种目标都不直接验证参考回答正确性。

### 验证范围：我们还缺什么证据

| 验证项 | 微软公开验证 | Agent Insight 本次验证 |
| --- | --- | --- |
| 词汇覆盖及人工评分 | 已报告 | 已做；上方逐项并列 |
| LLM 对样本集的偏好 | 已报告 | 未做；本次坚持无 LLM 验证 |
| 下游微调及留出集生成质量 | 已报告 | 未做，不能从词汇覆盖推导 |
| 与微软官方算法同池比较 | 公开数值来自其自身实验 | 尚未取得可复现的完整算法/数据配置，无法判断双方胜负 |

[三方对照 CSV](examples/coverage-v5/microsoft-v4-v5.csv)与[可缩放图](examples/coverage-v5/microsoft-v4-v5.svg)可直接查看。以下保留本地完整结果、消融、边界条件和历史基线，所有既有实验原始数值保持不变。本轮报告排版、数据核对与测试见[呈现验证记录](examples/coverage-v5/presentation-verification.json)。

'''
    checksums = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in artifacts.iterdir() if p.is_file() and p.name != 'checksums.json'}
    (artifacts / 'checksums.json').write_text(json.dumps(checksums, indent=2))
    return overview, section
