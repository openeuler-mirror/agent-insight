"""Publish three frozen rounds, including unsuccessful gates and earlier evidence."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
from statistics import mean, median
import shutil
import sys

root, docs = map(Path, sys.argv[1:3])
out = docs/'examples'/'weighted-three-rounds-v611-v613'
out.mkdir(parents=True, exist_ok=True)
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
rounds = {'V611': 'v611', 'V612': 'v612', 'V613': 'v613'}
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0', 'B4', 'C', 'V610', 'V611', 'V612', 'V613']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
table = lambda headers, rows: '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str, row))+' |' for row in rows])
label = lambda r: r['dataset']+(' / '+r['stratum'] if r['stratum'] != 'all' else '')
pct = lambda n: f'{n:+.2f}%'
audits, reports = {}, {}
for method, directory in rounds.items():
    current = root/directory
    audits[method] = json.loads((current/'verification.json').read_text())
    assert audits[method]['passed'] and audits[method]['scenarios'] == 77
    assert audits[method]['auditorSha256'] == sha('scripts/trace-datasets/audit-weighted-rounds.ts')
    target = out/method.lower(); target.mkdir(exist_ok=True)
    for name in names:
        data = (current/f'{name}.json').read_bytes()
        report = json.loads(data); assert report['finishedAt']
        for file, digest in report['plan']['codeHashes'].items(): assert sha(file) == digest
        with (target/f'{name}.json.gz').open('wb') as handle:
            with gzip.GzipFile(fileobj=handle, mode='wb', filename='', mtime=0) as z: z.write(data)
        if method == 'V613': reports[name] = report
    for file in ['plan.json', 'verification.json']: shutil.copyfile(current/file, target/file)
primary, quality, flat, sizes, sensitivities = [], [], [], [], []
for name, report in reports.items():
    grouped = {}
    for s in report['scenarios']:
        for m, run in s['methods'].items():
            flat.append(dict(dataset=name, stratum=s['stratum'], population=s['population'], k=s['k'], seed=s['seed'], method=m, vocabulary=run['metrics']['vocabulary'], tokens=run['metrics']['tokens'], quality=json.dumps(run['metrics']['quality']), selection_ms=run['selectionMs']))
        if s['k'] == 100: grouped.setdefault((s['stratum'], s['population']), []).append(s)
        elif s['population'] == 'all': sizes.append(dict(dataset=name, **s))
        if s['k'] == 100 and s['seed'] == 42 and s['population'] == 'all': sensitivities.append(dict(dataset=name, **s))
    for (stratum, population), trials in grouped.items():
        assert sorted(s['seed'] for s in trials) == [42, 100, 101, 102, 103]
        eq = [e for e in audits['V613']['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (name, stratum, population, 100)]
        assert len(eq) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, methods={m: {k: mean(s['methods'][m]['metrics'][k] for s in trials) for k in ['vocabulary', 'tokens']} for m in methods}, equal={m: mean(e[m] for e in eq) for m in methods}, fixedEqual={m: mean(e['fixed'][m] for e in eq) for m in methods}, feasible={m: sum(s['methods'][m]['optimization']['feasible'] for s in trials) for m in rounds}, weightedReplacements=mean(s['methods']['V612']['weighted']['replacements'] for s in trials), pairwisePasses=mean(s['methods']['V613']['pairwise']['passes'] for s in trials), pairwiseAccepted=mean(s['methods']['V613']['pairwise']['accepted'] for s in trials), pairwiseTested=mean(s['methods']['V613']['pairwise']['testedPairs'] for s in trials)))
        for axis in trials[0]['methods']['V613']['metrics']['quality']:
            quality.append(dict(dataset=name, stratum=stratum, population=population, axis=axis, **{m: mean(s['methods'][m]['metrics']['quality'][axis]['mean'] for s in trials) for m in methods}))
gain = lambda r, m: 100*(r['methods'][m]['vocabulary']/r['methods']['B0']['vocabulary']-1)
coverage = [r for r in primary if r['dataset'] in ms and r['population'] == 'all']
mainq = [r for r in quality if (r['dataset'] == 'OASST2' and r['population'] == 'quality-annotated' and r['axis'] == 'quality') or (r['dataset'] == 'HelpSteer2' and r['axis'] == 'helpfulness') or (r['dataset'] == 'SummarizeFeedback' and r['axis'] == 'overall')]
gates = {}
for m in rounds:
    gates[m] = []
    for r in coverage:
        target = max(ms[r['dataset']]+5, gain(r, 'C')); reasons = []
        if gain(r, m) < target: reasons.append('原始覆盖不足')
        eq = [e for e in audits[m]['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (r['dataset'], r['stratum'], r['population'], 100)]
        if mean(e[m] for e in eq) < mean(e['C'] for e in eq): reasons.append('同 token 低于 v5')
        if r['feasible'][m] < 5: reasons.append('不可行回退')
        gates[m].append(dict(condition=label(r)+' / 词汇', value=gain(r, m), target=target, passed=not reasons, reason='；'.join(reasons) or '通过'))
    for r in mainq:
        target = max(r['B0'], r['B4']) if r['dataset'] == 'HelpSteer2' else max(r['B0']*1.1, r['C'])
        gates[m].append(dict(condition=label(r)+' / '+r['axis'], value=r[m], target=target, passed=r[m] >= target, reason='通过' if r[m] >= target else '人工评分不足'))
    assert len(gates[m]) == 11
status = json.loads((root/'test-status.json').read_text())
assert status['focusedPassed'] and status['scriptTypecheckPassed']
for file in ['test-status.json', 'full-failure-names.json']: shutil.copyfile(root/file, out/file)
perf = []
for name in names:
    runs = {v: json.loads((root/'performance-final'/f'{name}-{v}.json').read_text()) for v in ['v5', 'v610', 'v611', 'v612', 'v613']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['sourceSha256'] == reports[name]['dataSha256']
        assert run['resultsSha256'] == sha(root/'v613'/f'{name}.json')
        assert run['hardware'] == runs['v5']['hardware']
        shutil.copyfile(root/'performance-final'/f'{name}-{v}.json', out/f'performance-{name}-{v}.json')
    for i in range(len(runs['v5']['measurements'])):
        selected = {v: r['measurements'][i] for v, r in runs.items()}
        assert all(r['idsMatchFrozen'] for r in selected.values())
        ratios = {m: selected[m.lower()]['selectionMs']/selected['v5']['selectionMs'] for m in rounds}
        memory = {m: selected[m.lower()]['additionalHighWaterKiB']/selected['v5']['additionalHighWaterKiB'] if selected[m.lower()]['additionalHighWaterKiB'] and selected['v5']['additionalHighWaterKiB'] else None for m in rounds}
        perf.append(dict(dataset=name, stratum=selected['v5']['stratum'], runs=selected, ratios=ratios, memoryRatios=memory))
synthetic = []
for long in [False, True]:
    runs = {v: json.loads((root/'performance-final'/f'synthetic-{long}-{v}.json').read_text()) for v in ['v5', 'v611', 'v612', 'v613']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['cacheKey'] == runs['v5']['cacheKey']
        shutil.copyfile(root/'performance-final'/f'synthetic-{long}-{v}.json', out/f'synthetic-{long}-{v}.json')
    for i in range(3):
        measurements = {v: r['measurements'][i] for v, r in runs.items()}
        assert all(r['count'] == r['k'] for r in measurements.values())
        synthetic.append(dict(scenario='N1k 长输入' if long else 'N10k 短输入', k=measurements['v5']['k'], runs=measurements, ratios={m: measurements[m.lower()]['selectionMs']/measurements['v5']['selectionMs'] for m in rounds}))
summary = dict(status='offline_not_enabled', default='trace-coverage-v4', roundsCompleted=3, earlyStopped=False, primary=primary, quality=quality, gates=gates, passed={m: sum(g['passed'] for g in gs) for m, gs in gates.items()}, performance=perf, synthetic=synthetic, independentConfirmation='not_run', browserValidated=False)
(out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
with (out/'metrics.csv').open('w', newline='') as h:
    writer = csv.DictWriter(h, fieldnames=flat[0]); writer.writeheader(); writer.writerows(flat)
ct = table(['数据集', '微软公开', 'v5', 'v6.10 / v6.11 / v6.12', 'v6.13', 'v6.13 − 微软（百分点）', '原目标', '距原目标（百分点）'], [[r['dataset'], pct(ms[r['dataset']]), pct(gain(r, 'C')), pct(gain(r, 'V610')), pct(gain(r, 'V613')), f"{gain(r, 'V613')-ms[r['dataset']]:+.2f}", pct(max(ms[r['dataset']]+5, gain(r, 'C'))), f"{gain(r, 'V613')-max(ms[r['dataset']]+5, gain(r, 'C')):+.2f}"] for r in coverage])
qt = table(['人工质量轴', '随机', 'v6.10 / v6.11', 'v6.12', 'v6.13', '原目标', 'v6.13 − v6.10'], [[label(r)+' / '+r['axis'], f"{r['B0']:.3f}", f"{r['V610']:.3f}", f"{r['V612']:.3f}", f"{r['V613']:.3f}", f"{gates['V613'][6+i]['target']:.3f}", f"{r['V613']-r['V610']:+.3f}"] for i, r in enumerate(mainq)])
gt = table(['原验收条件', '原目标', '第一轮 v6.11', '第二轮 v6.12', '第三轮 v6.13', 'v6.13 判定'], [[g['condition'], f"{g['target']:.3f}", *[f"{gates[m][i]['value']:.3f} / {'通过' if gates[m][i]['passed'] else '未通过'}" for m in rounds], g['reason']] for i, g in enumerate(gates['V613'])])
rt = table(['轮次', '调整', '主效果门槛', '真实池 3 倍耗时门槛', '提前停止条件'], [[m.replace('V6', 'v6.'), change, f"{summary['passed'][m]}/11", f"{sum(p['ratios'][m] <= 3 for p in perf)}/10", '未满足'] for m, change in zip(rounds, ['共享特征与批量重建', '稀有度加权回答共识', '有界二换二搜索'])])
pt = table(['真实池 / K100 seed42', 'v5', 'v6.10', 'v6.11', 'v6.12', 'v6.13', 'v6.13 / v5'], [[label(p), *[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5', 'v610', 'v611', 'v612', 'v613']], f"{p['ratios']['V613']:.2f}×"] for p in perf])
mt = table(['真实池', 'v5 / v6.11 / v6.12 / v6.13 峰值 RSS MiB', '对应高水位增量 MiB', 'v6.13 增量 1.5 倍门槛'], [[label(p), ' / '.join(f"{p['runs'][m]['maxRssKiB']/1024:.1f}" for m in ['v5', 'v611', 'v612', 'v613']), ' / '.join(f"{p['runs'][m]['additionalHighWaterKiB']/1024:.1f}" for m in ['v5', 'v611', 'v612', 'v613']), '数据不足' if p['memoryRatios']['V613'] is None else '通过' if p['memoryRatios']['V613'] <= 1.5 else '未通过'] for p in perf])
synthetic_table = table(['合成边界场景', 'K', 'v5', 'v6.11', 'v6.12', 'v6.13', 'v6.13 / v5'], [[p['scenario'], p['k'], *[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5', 'v611', 'v612', 'v613']], f"{p['ratios']['V613']:.2f}×"] for p in synthetic])
et = table(['数据及分层', 'v6.11 / v6.12 / v6.13 同 token 相对 v5', 'v6.12 回答替换数', 'v6.13 搜索轮数 / 接受交换数 / 检查组合数'], [[label(r), ' / '.join(pct(100*(r['equal'][m]/r['equal']['C']-1)) for m in rounds), f"{r['weightedReplacements']:.1f}", f"{r['pairwisePasses']:.1f} / {r['pairwiseAccepted']:.1f} / {r['pairwiseTested']:.1f}"] for r in primary if r['population'] == 'all'])

guards = [r for r in quality if (r['dataset'] == 'HelpSteer2' and r['axis'] == 'correctness') or (r['dataset'] == 'SummarizeFeedback' and r['axis'] in ['accuracy', 'coverage', 'coherence'])]
guard_table = table(['质量防退步轴', '随机', 'v4', 'v6.10 / v6.11', 'v6.12', 'v6.13'], [[label(r)+' / '+r['axis'], *[f'{r[m]:.3f}' for m in ['B0', 'B4', 'V610', 'V612', 'V613']]] for r in guards])
size_table = table(['数据及分层', 'K / seed42', 'v6.11', 'v6.12', 'v6.13', '三轮均可行'], [[label(s), s['k'], *[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds], all(s['methods'][m]['optimization']['feasible'] for m in rounds)] for s in sizes])
budget_table = table(['数据及分层', '预算', 'v6.11', 'v6.12', 'v6.13', '三轮均可行'], [[label(s), ratio, *[pct(100*(s['methods'][m+suffix]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds], all(s['methods'][m+suffix]['optimization']['feasible'] for m in rounds)] for s in sensitivities for ratio, suffix in [(1, '_1'), (1.1, ''), (1.2, '_1.2')]])
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig, axes = plt.subplots(1, 2, figsize=(15, 7), layout='constrained')
y = np.arange(6)
for offset, values, color, title in [(-.22, [ms[r['dataset']] for r in coverage], '#b45309', 'Microsoft published'), (0, [gain(r, 'V610') for r in coverage], '#64748b', 'v6.10 / v6.11 / v6.12'), (.22, [gain(r, 'V613') for r in coverage], '#0369a1', 'v6.13')]:
    bars = axes[0].barh(y+offset, values, height=.2, color=color, label=title); axes[0].bar_label(bars, fmt='%.1f', padding=3, fontsize=8)
axes[0].scatter([max(ms[r['dataset']]+5, gain(r, 'C')) for r in coverage], y, marker='|', s=200, color='#dc2626', label='Original target')
axes[0].set_yticks(y, [r['dataset'] for r in coverage]); axes[0].invert_yaxis(); axes[0].set_xlabel('Vocabulary uplift over random (%)'); axes[0].set_title('Coverage: public numerical targets\nMicrosoft uses a different pool/protocol'); axes[0].legend(fontsize=8, loc='lower right'); axes[0].margins(x=.16)
yq = np.arange(5)
for offset, m, color in [(-.22, 'V610', '#64748b'), (0, 'V612', '#0f766e'), (.22, 'V613', '#0369a1')]:
    values = [100*r[m]/gates['V613'][6+i]['target'] for i, r in enumerate(mainq)]
    bars = axes[1].barh(yq+offset, values, height=.2, color=color, label=m.replace('V6', 'v6.')); axes[1].bar_label(bars, fmt='%.1f%%', padding=3, fontsize=8)
axes[1].axvline(100, color='#dc2626', linestyle='--', label='Original target'); axes[1].set_yticks(yq, ['OASST2 quality', 'HelpSteer2 helpfulness', 'CNN-DM overall', 'TLDR valid2 overall', 'TLDR valid1 overall']); axes[1].invert_yaxis(); axes[1].set_xlim(0, 117); axes[1].set_title('Human quality: percentage of target reached\nFrozen K100, five seeds; labels only after selection'); axes[1].legend(fontsize=8, loc='upper center', bbox_to_anchor=(.5, -.06), ncol=4)
for ax in axes: ax.grid(axis='x', alpha=.2); ax.set_axisbelow(True)
fig.savefig(out/'comparison.png', dpi=170); fig.savefig(out/'comparison.svg', metadata={'Date': None}); plt.close(fig)
new_passes = [g['condition'] for i, g in enumerate(gates['V613']) if g['passed'] and not gates['V611'][i]['passed']]
lost_passes = [g['condition'] for i, g in enumerate(gates['V613']) if not g['passed'] and gates['V611'][i]['passed']]
text = f'''<!-- WEIGHTED-THREE-ROUNDS-REPORT-START -->
## 本次三轮优化：v6.11 / v6.12 / v6.13

**本次授权的 3 轮均已完成，共 297 次候选运行，未提前停止，整体目标仍未达成。** 主要效果条件依次通过 {summary['passed']['V611']}/11、{summary['passed']['V612']}/11、{summary['passed']['V613']}/11；默认继续 v4。相对上一轮 v6.10，最终新增通过项：{'、'.join(new_passes) or '无'}；失去的通过项：{'、'.join(lost_passes) or '无'}。效果和资源门槛分别列出，不以总平均提高代替逐项达标。

{rt}

本次主要收益来自第二轮：TLDR/valid2 overall 从 5.071 升到 5.305，超过原目标 5.209；HelpSteer2 helpfulness 从 2.854 升到 2.880，仍不足 2.928。OASST2 quality 从 0.7414 降到 0.7357、CNN-DM overall 从 6.028 降到 6.0045，虽然仍达标，退步也保留。NoRobots/OASST2 覆盖与 HelpSteer2 质量这三项主条件仍未通过，资源等放行条件另行判断。

第三轮 K100 主场景完全保持第二轮的入选结果；99 个场景中仅两个 K20/seed42 场景接受交换：HelpSteer2 词汇 1483→1527、成本 2718→2717；TLDR/valid1 词汇 1709→1710、成本 6043→6048，仍在原预算内。它未增加主条件通过数，不把边界收益表述为整体采样效果进一步提升。

### 与微软公开数值的直接差距

{ct}

各列为相对各自随机基线的输入词汇增幅；微软列沿用[既有公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)的冻结参照。微软与本地候选池、协议不同，因此此表比较公开数值，不证明同池算法胜负。原要求保持 max(微软增幅 + 5 个百分点, v5 增幅)，并要求同 token 覆盖不低于 v5、预算与分布等同时满足。

![三轮与微软及原目标的直接差距](examples/weighted-three-rounds-v611-v613/comparison.png)

### 人工质量与原来的 11 项条件

{qt}

质量表使用 K100 五种子均值。OASST2 quality 仍用原 quality-annotated 池，覆盖仍用 all 池；HelpSteer2 helpfulness 要求不低于随机及 v4，其他四项质量要求不低于随机的 1.10 倍且不低于 v5。人工评分只在采样返回 ID 后读取。下面将六项覆盖条件和五项质量合并判断，与上面两张表是同一批结果。

{gt}

v6.11 精确保持旧结果；v6.12 只更换同输入回答，不能改善输入覆盖；v6.13 更换输入组合，在提升覆盖的同时仍可能改变人工质量。加权共识衡量的是词项支持，不能从稀有度推导正确性或有用性，也不能把任一数据集改善推广到其他来源。

质量防退步轴保留原始均值；所有其他人工标注轴也保存在汇总 JSON 与逐场景指标中：

{guard_table}

### 三轮实现与边界

1. **v6.11 共享特征和批量状态重建**：每个去重回答规范化、词项和交集只计算一次，同时得到原 Jaccard 与 F2；单回答零分不做无用交集。初始状态批量累计引用计数再扫描输入组计算边际覆盖。原构造、排序、交换和禁忌轨迹完整保留，99 场景精确回放 v6.10 的有序 ID、路径、原因及诊断（版本名除外）。所有缓存仅为单次调用内存，保留协作式让出点。真实池相对 v6.10 的选样耗时比值中位变化为 {pct(100*(median(p['runs']['v611']['selectionMs']/p['runs']['v610']['selectionMs'] for p in perf)-1))}；单次测量不代表稳定加速比。
2. **v6.12 稀有度加权回答共识**：权重固定为 1+ln((G+1)/(df+1))，G 为输入组数，df 为回答包含该词项的输入组数；同输入所有回答合并只计一次频次。加权交集与加权词项质量代入 F2，平均最多 32 个规范化去重支持。仅严格提高且保留路径、无重复问答时换回答，平分保留起点。输入序列、token 成本和原始覆盖不变；罕见错误词也会被赋予较大权重，实际质量必须独立验收。
3. **v6.13 有界二换二搜索**：最多 4 次交换，24 个低覆盖损失移出项；未选输入按最好单交换净收益和成本效率各取前 32 的并集，对每对移出项再取边际覆盖与成本效率各前 8 的并集。精算共有词、丢失词和恢复词，避免两条输入的共享词被重复计为增益。每步守住数量、独立输入数、预算/TV、起点任务与真实路径；只接受正覆盖收益或等覆盖严格节省。回答/路径组合按加权共识选可行最高项，平分用稳定键；覆盖和成本上下界同时饱和可跳过。短名单仍可能漏掉全局最好组合，不宣称全局最优。

{et}

同 token 仍使用原 QA ID 计量排序，换回答会改变 ID，从而可能改变截断后的覆盖，即使输入集合完全不变。每轮验收使用该轮全部对照的共同预算；上表用最终全对照预算并列展示。审计还保留固定 v6.4 预算口径，未针对计量散列选样，未修改质量阈值。

### 性能和资源

同机串行、每个数据集和算法独立进程复测 K100/seed42，摘要分层共用一个进程；ID 与冻结结果逐个对齐，代码、原数据、结果 SHA256 一并保存。输入 MinHash 使用带 checksum 的研究临时缓存，加载/输入准备单列，所有回答特征工作都计入选样耗时。以下不是生产端到端耗时。

{pt}

最终真实池的 3 倍 v5 耗时门槛通过 {sum(p['ratios']['V613'] <= 3 for p in perf)}/10。单次测量存在运行时、GC 和同机常驻服务波动，不作为置信区间；正式 Worker 并发和端到端性能尚未通过验证。

{mt}

高水位 RSS 增量是选样后的进程峰值减选样前峰值，包含 V8/GC 及准备阶段的影响，只是增量内存代理。分母或增量为零时标为“数据不足”，不能视为 1.5 倍门槛通过；未用峰值代理替代四 Worker 的真实资源验证。

{synthetic_table}

短输入 N=10,000、长输入 N=1,000 均测 K20/100/500；相同 fixture 和校验缓存，原特征冷准备与本次加载耗时单列。合成场景不能代替真实池、Worker 或 Web UI。

### 规模、预算和验证证据

每轮沿用八源原池，K100 种子 42/100/101/102/103；seed42 的 K20/K500 及预算倍率 1.00/1.10/1.20 不变。每轮 77 主场景加 22 预算敏感性，三轮共 297 次候选运行。表格列公开 all 池，OASST2 有标注子池的全部场景也保存在原始结果中。

{size_table}

{budget_table}

三轮审计从原始文本独立复算词汇、成本、分布、上界及全部人工质量均值，校验来源/源码指纹与历史结果。各预算均验证 v6.11 完全回放、v6.12 输入/成本/覆盖不变、v6.13 覆盖不减及等覆盖成本不增；真实路径和混合输入变体约束另有针对性测试。审计的累计入选记录数含历史对照，不等于新增候选运行数。

新增 9 项测试，完整专项 {status['focused']['pass']}/{status['focused']['tests']} 通过，覆盖共享特征等价性、文档频次去重、状态重建、多预算、回答替换、二换二负收益屏障、联合路径可行性、穷举上界、预算/TV、回退及取消。新采样器、研究脚本与测试严格类型检查通过；全仓类型检查仍被 dev 生成 routes.d.ts 的四处语法错误阻断。

全仓测试共 {status['fullSuite']['tests']} 项：{status['fullSuite']['pass']} 通过、{status['fullSuite']['fail']} 失败、{status['fullSuite']['skipped']} 跳过。与上一轮失败名称比较，新增 {len(status['newFailureNames'])} 项，消失 {len(status['resolvedFailureNames'])} 项；完整名称和复查说明见测试记录。保留原始全量统计，不用复测覆盖原失败，也不将全部失败笼统归为环境原因。

本轮新增失败是 MCTS 配置测试的 after-hook 删除临时数据库目录时报 `ENOTEMPTY`，该模块本轮未修改；单独复测 1/1 通过。复测仍有后台缺表警告，不能据此断言完整根因已经解决；原始全量失败数继续保留。

已知数据已多轮用于开发，当前证据仍是回归实验，未完成新来源独立确认。新候选未接入生产 Worker，**本次未在浏览器中验证**，旧 v4 UI 证据不代替本轮。覆盖、质量、资源与独立确认尚未全部通过；本次三轮结束，默认继续 v4。

证据：[汇总](examples/weighted-three-rounds-v611-v613/summary.json)、[逐场景指标](examples/weighted-three-rounds-v611-v613/metrics.csv)、[源码哈希](examples/weighted-three-rounds-v611-v613/implementation.json)、[测试记录](examples/weighted-three-rounds-v611-v613/test-status.json)、[全量失败名称](examples/weighted-three-rounds-v611-v613/full-failure-names.json)、[证据校验](examples/weighted-three-rounds-v611-v613/report-verification.json)。三个版本目录包含全部 24 份压缩原始实验和各轮 plan/verification；同目录保存独立进程性能。以下历史报告与证据保持原样。

<!-- WEIGHTED-THREE-ROUNDS-REPORT-END -->

'''
report = docs/'eight-datasets-comparison-report.md'
old = report.read_text()
if old.startswith('<!-- WEIGHTED-THREE-ROUNDS-REPORT-START -->'): old = old.split('<!-- WEIGHTED-THREE-ROUNDS-REPORT-END -->\n\n', 1)[1]
report.write_text(text+old)
files = ['src/lib/trace-datasets/sampling/'+n+'.ts' for n in ['budgeted-indexed', 'answer-shared', 'budgeted-reused', 'answer-weighted', 'budgeted-pairwise']]+['scripts/trace-datasets/'+n for n in ['compare-weighted-rounds.ts', 'audit-weighted-rounds.ts', 'benchmark-weighted-rounds.ts', 'benchmark-weighted-rounds-synthetic.ts', 'report-weighted-rounds.py']]+['test/trace-datasets-reused-weighted.test.ts', 'test/trace-datasets-pairwise.test.ts']
(out/'implementation.json').write_text(json.dumps({f: sha(f) for f in files}, indent=2))
print(json.dumps({'rounds': 3, 'passed': summary['passed'], 'report': str(report)}, ensure_ascii=False))
