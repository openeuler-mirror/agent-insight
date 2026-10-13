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
out = docs/'examples'/'three-rounds-v65-v67'
out.mkdir(parents=True, exist_ok=True)
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
rounds = {'V65': 'v65-final', 'V66': 'v66', 'V67': 'v67'}
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0', 'B4', 'C', 'V64', 'V65', 'V66', 'V67']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
table = lambda headers, rows: '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str, row))+' |' for row in rows])
label = lambda r: r['dataset']+(' / '+r['stratum'] if r['stratum'] != 'all' else '')
pct = lambda n: f'{n:+.2f}%'
audits, reports = {}, {}
for method, directory in rounds.items():
    current = root/directory
    audits[method] = json.loads((current/'verification.json').read_text())
    assert audits[method]['passed'] and audits[method]['scenarios'] == 77
    assert audits[method]['auditorSha256'] == sha('scripts/trace-datasets/audit-three-rounds.ts')
    target = out/method.lower(); target.mkdir(exist_ok=True)
    for name in names:
        data = (current/f'{name}.json').read_bytes()
        report = json.loads(data); assert report['finishedAt']
        for file, digest in report['plan']['codeHashes'].items(): assert sha(file) == digest
        with (target/f'{name}.json.gz').open('wb') as handle:
            with gzip.GzipFile(fileobj=handle, mode='wb', filename='', mtime=0) as z: z.write(data)
        if method == 'V67': reports[name] = report
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
        eq = [e for e in audits['V67']['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (name, stratum, population, 100)]
        assert len(eq) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, methods={m: {k: mean(s['methods'][m]['metrics'][k] for s in trials) for k in ['vocabulary', 'tokens']} for m in methods}, equal={m: mean(e[m] for e in eq) for m in methods}, fixedEqual={m: mean(e['fixed'][m] for e in eq) for m in methods}, feasible={m: sum(s['methods'][m]['optimization']['feasible'] for s in trials) for m in rounds}, answerReplacements=mean(s['methods']['V66']['agreement']['replacements'] for s in trials), inputSwaps=mean(s['methods']['V67']['agreement']['inputSwaps'] for s in trials)))
        for axis in trials[0]['methods']['V67']['metrics']['quality']:
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
    runs = {v: json.loads((root/'performance-final'/f'{name}-{v}.json').read_text()) for v in ['v5', 'v64', 'v65', 'v66', 'v67']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['sourceSha256'] == reports[name]['dataSha256']
        assert run['resultsSha256'] == sha(root/'v67'/f'{name}.json')
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
    runs = {v: json.loads((root/'performance-final'/f'synthetic-{long}-{v}.json').read_text()) for v in ['v5', 'v65', 'v66', 'v67']}
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
ct = table(['数据集', '微软公开', 'v5', 'v6.4 / v6.5 / v6.6', 'v6.7', 'v6.7 − 微软（百分点）', '原目标', '距原目标（百分点）'], [[r['dataset'], pct(ms[r['dataset']]), pct(gain(r, 'C')), pct(gain(r, 'V64')), pct(gain(r, 'V67')), f"{gain(r, 'V67')-ms[r['dataset']]:+.2f}", pct(max(ms[r['dataset']]+5, gain(r, 'C'))), f"{gain(r, 'V67')-max(ms[r['dataset']]+5, gain(r, 'C')):+.2f}"] for r in coverage])
qt = table(['人工质量轴', '随机', 'v6.4 / v6.5', 'v6.6', 'v6.7', '原目标', 'v6.7 − v6.4'], [[label(r)+' / '+r['axis'], f"{r['B0']:.3f}", f"{r['V64']:.3f}", f"{r['V66']:.3f}", f"{r['V67']:.3f}", f"{gates['V67'][6+i]['target']:.3f}", f"{r['V67']-r['V64']:+.3f}"] for i, r in enumerate(mainq)])
gt = table(['原验收条件', '原目标', '第一轮 v6.5', '第二轮 v6.6', '第三轮 v6.7', 'v6.7 判定'], [[g['condition'], f"{g['target']:.3f}", *[f"{gates[m][i]['value']:.3f} / {'通过' if gates[m][i]['passed'] else '未通过'}" for m in rounds], g['reason']] for i, g in enumerate(gates['V67'])])
rt = table(['轮次', '调整', '主效果门槛', '真实池 3 倍耗时门槛', '提前停止条件'], [[m.replace('V6', 'v6.'), change, f"{summary['passed'][m]}/11", f"{sum(p['ratios'][m] <= 3 for p in perf)}/10", '未满足'] for m, change in zip(rounds, ['等价计算加速', '同输入回答共识代表', '覆盖保底下的输入一致性交换'])])
pt = table(['真实池 / K100 seed42', 'v5', 'v6.4', 'v6.5', 'v6.6', 'v6.7', 'v6.7 / v5'], [[label(p), *[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5', 'v64', 'v65', 'v66', 'v67']], f"{p['ratios']['V67']:.2f}×"] for p in perf])
mt = table(['真实池', 'v5 / v6.5 / v6.6 / v6.7 峰值 RSS MiB', '对应高水位增量 MiB', 'v6.7 增量 1.5 倍门槛'], [[label(p), ' / '.join(f"{p['runs'][m]['maxRssKiB']/1024:.1f}" for m in ['v5', 'v65', 'v66', 'v67']), ' / '.join(f"{p['runs'][m]['additionalHighWaterKiB']/1024:.1f}" for m in ['v5', 'v65', 'v66', 'v67']), '数据不足' if p['memoryRatios']['V67'] is None else '通过' if p['memoryRatios']['V67'] <= 1.5 else '未通过'] for p in perf])
synthetic_table = table(['合成边界场景', 'K', 'v5', 'v6.5', 'v6.6', 'v6.7', 'v6.7 / v5'], [[p['scenario'], p['k'], *[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5', 'v65', 'v66', 'v67']], f"{p['ratios']['V67']:.2f}×"] for p in synthetic])
et = table(['数据及分层', 'v6.5 / v6.6 / v6.7 同 token 相对 v5', 'v6.6 回答替换数', 'v6.7 输入替换数'], [[label(r), ' / '.join(pct(100*(r['equal'][m]/r['equal']['C']-1)) for m in rounds), f"{r['answerReplacements']:.1f}", f"{r['inputSwaps']:.1f}"] for r in primary if r['population'] == 'all'])
guards = [r for r in quality if (r['dataset'] == 'HelpSteer2' and r['axis'] == 'correctness') or (r['dataset'] == 'SummarizeFeedback' and r['axis'] in ['accuracy', 'coverage', 'coherence'])]
guard_table = table(['质量防退步轴', '随机', 'v4', 'v6.4 / v6.5', 'v6.6', 'v6.7'], [[label(r)+' / '+r['axis'], *[f'{r[m]:.3f}' for m in ['B0', 'B4', 'V64', 'V66', 'V67']]] for r in guards])
size_table = table(['数据及分层', 'K / seed42', 'v6.5', 'v6.6', 'v6.7', '三轮均可行'], [[label(s), s['k'], *[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds], all(s['methods'][m]['optimization']['feasible'] for m in rounds)] for s in sizes])
budget_table = table(['数据及分层', '预算', 'v6.5', 'v6.6', 'v6.7', '三轮均可行'], [[label(s), ratio, *[pct(100*(s['methods'][m+suffix]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds], all(s['methods'][m+suffix]['optimization']['feasible'] for m in rounds)] for s in sensitivities for ratio, suffix in [(1, '_1'), (1.1, ''), (1.2, '_1.2')]])
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig, axes = plt.subplots(1, 2, figsize=(15, 7), layout='constrained')
y = np.arange(6)
for offset, values, color, title in [(-.22, [ms[r['dataset']] for r in coverage], '#b45309', 'Microsoft published'), (0, [gain(r, 'V64') for r in coverage], '#64748b', 'v6.4 / v6.5 / v6.6'), (.22, [gain(r, 'V67') for r in coverage], '#0369a1', 'v6.7')]:
    bars = axes[0].barh(y+offset, values, height=.2, color=color, label=title); axes[0].bar_label(bars, fmt='%.1f', padding=3, fontsize=8)
axes[0].scatter([max(ms[r['dataset']]+5, gain(r, 'C')) for r in coverage], y, marker='|', s=200, color='#dc2626', label='Original target')
axes[0].set_yticks(y, [r['dataset'] for r in coverage]); axes[0].invert_yaxis(); axes[0].set_xlabel('Vocabulary uplift over random (%)'); axes[0].set_title('Coverage: public numerical targets\nMicrosoft uses a different pool/protocol'); axes[0].legend(fontsize=8, loc='lower right'); axes[0].margins(x=.16)
yq = np.arange(5)
for offset, m, color in [(-.22, 'V64', '#64748b'), (0, 'V66', '#0f766e'), (.22, 'V67', '#0369a1')]:
    values = [100*r[m]/gates['V67'][6+i]['target'] for i, r in enumerate(mainq)]
    bars = axes[1].barh(yq+offset, values, height=.2, color=color, label=m.replace('V6', 'v6.')); axes[1].bar_label(bars, fmt='%.1f%%', padding=3, fontsize=8)
axes[1].axvline(100, color='#dc2626', linestyle='--', label='Original target'); axes[1].set_yticks(yq, ['OASST2 quality', 'HelpSteer2 helpfulness', 'CNN-DM overall', 'TLDR valid2 overall', 'TLDR valid1 overall']); axes[1].invert_yaxis(); axes[1].set_xlim(0, 117); axes[1].set_title('Human quality: percentage of target reached\nFrozen K100, five seeds; labels only after selection'); axes[1].legend(fontsize=8, loc='upper center', bbox_to_anchor=(.5, -.06), ncol=4)
for ax in axes: ax.grid(axis='x', alpha=.2); ax.set_axisbelow(True)
fig.savefig(out/'comparison.png', dpi=170); fig.savefig(out/'comparison.svg', metadata={'Date': None}); plt.close(fig)
text = f'''<!-- THREE-ROUNDS-REPORT-START -->
## 三轮优化完成：v6.5 / v6.6 / v6.7

**已按授权完成 3 轮，没有提前停止；整体目标仍未达成，默认继续 v4。** 主效果门槛依次通过 {summary['passed']['V65']}/11、{summary['passed']['V66']}/11、{summary['passed']['V67']}/11。质量收益与失败项同时保留，不改变原目标，不接入生产 Worker。

{rt}

### 与微软的差距，以及原要求的差距

{ct}

这里的“微软差距”直接比较六项词汇增幅；原验收还要求至少高 5 个百分点、不低于 v5，同时满足同 token、预算和分布约束。微软数值沿用[既有公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)的冻结参照，双方池与协议不同，不代表同池算法胜负。v6.5 精确回放 v6.4；v6.6 只换回答，因此三者原始输入覆盖相同。

![三轮优化与微软、原目标的差距](examples/three-rounds-v65-v67/comparison.png)

### 人工质量与全部 11 项主条件

{qt}

{gt}

前六行是词汇增幅（%），后五行是原量纲人工评分。OASST2 和摘要取 max(随机×1.10,v5)，HelpSteer2 取 max(随机,v4)。这些标签只在选择结束后验收；未根据来源或评分切换规则。缺失评分不按零处理，全部 labeled 数量保留在原始证据。

### 三轮分别检验了什么

1. **v6.5 等价加速**：单次交换复用独占词项归属与分布可行性，提前拒绝超预算方案；缓存同时绑定状态对象和修订号，避免跨起点污染。77 个场景及 22 个预算敏感性保持有序 ID 和诊断不变；路径/原因在约束混合池专项精确回放。真实池加速并未保证达到 v5 的 3 倍耗时门槛。
2. **v6.6 回答共识**：对同输入的去重回答计算词项集合的平均 Jaccard，最多取按回答键排序的 32 个其他回答支持。只接受严格更高得分、保持原路径格子的替换，不改变输入顺序、成本或原始覆盖。单回答无证据，双回答对称得分无法区分，平分保留原答案。HelpSteer2 的两回答结构因此没有变化。
3. **v6.7 输入一致性交换**：在第二轮上最多 min(16,K) 次替换；只换掉当前唯一入选回答对应的输入，优先增加输入组平均回答一致性，再比较覆盖收益与成本。守住 v6.5 原始覆盖下限、原预算/TV，并保守保护起点全部任务与真实路径。允许使用前一步覆盖盈余，但最终不能低于起点；未利用人工质量、来源名称或同 token 计量顺序。

一致性仅是无 LLM 代理信号。相似回答可能共同出错，重复措辞也可能抬高得分；它不能验证语义正确性、上下文独立性，也不作为过滤规则。第三轮能否改善人工评分必须看实测，不能由代理分数提升推断。

{et}

同 token 表统一使用本轮全部主方法的最小 token 预算；每一轮的门槛判定使用该轮可用对照的共同预算。审计另外保存固定 v6.4 比较预算，避免口径漂移。计量仍按冻结问答 ID 散列排序，因此即使第二轮输入集合不变，换回答也可能改变截断时先计入哪个输入，导致同 token 指标变化；这不代表输入词汇集合发生了变化。采样器不读取该排序。

### 质量防退步检查

{guard_table}

完整全部评分轴见 CSV/JSON；这些已知回归池不能证明新来源上的质量非劣性。

### 数量与预算敏感性

{size_table}

{budget_table}

主结果固定 1.10 倍预算，1.20 倍只是诊断。每轮八源共 77 个主场景，加 22 个预算敏感性运行；三轮合计 297 次候选运行。

### 实际池性能与验证

{pt}

{mt}

v6.5 相对 v6.4 在 10 个真实分层的选样耗时降幅中位数为 {median(100*(1-p['runs']['v65']['selectionMs']/p['runs']['v64']['selectionMs']) for p in perf):.1f}%，但三轮均只有 0/10 个分层达到 3 倍耗时门槛。

最终性能在八源、五个版本上串行独立进程复测，K100 seed42，并核对输出 ID。回答特征计算包含在 v6.6/v6.7 的选样耗时内；输入特征准备单列。摘要三个分层共用进程。高水位增量只是 RSS 代理，零值代表准备峰值未被超过，不能当作零分配；单次结果受后台服务影响。研究签名缓存不属于生产存储。这里不声称四 Worker 或全链路性能已验收。

{synthetic_table}

合成边界覆盖 N10k、K500 和 N1k 长输入，使用校验和确认相同临时特征；冷启动特征生成时间与缓存读取时间单列，不混入选样比值。K 顺序累计的 RSS 见原始 JSON。单回答合成池与覆盖上界提前结束不能代表多回答真实池或完整搜索，仍以真实池失败项阻止放行。

专项并发首跑 95/96，任务清理状态断言失败；随后完整专项串行复测 {status['focused']['pass']}/{status['focused']['tests']} 通过，保留首跑记录。新增 9 项测试覆盖等价回放、共识边界、真实路径、混合预算/分布、输入变体、回退和取消。新采样器及研究脚本严格类型检查通过。全仓测试 {status['fullSuite']['pass']} 通过、{status['fullSuite']['fail']} 失败、{status['fullSuite']['skipped']} 跳过；全仓类型检查{'通过' if status['typecheckPassed'] else '未通过，仍被 dev 生成 routes.d.ts 的四处语法错误阻断'}。

相较上轮失败名记录，镜像池的 `IMAGE_POOL_WAIT_TIMEOUT`（测试设置 waitMs=25）和内置数据集只读 UI 的精确源码正则断言是两个新增失败名，单独复测均仍失败。本轮没有修改这两个模块；不把其原因未经定位归结为负载，也不将全部失败统称为环境问题。全仓统计保留原始失败数，不用复测结果改写。

**未在浏览器中验证新候选；未完成新来源盲测、四 Worker 并发或新版生产接入。** 原默认与用户操作没有变化，历史 v4 UI 验证不能代替新版本。三轮原门槛仍有失败，因此不放行默认切换。

证据：[三轮汇总](examples/three-rounds-v65-v67/summary.json) · [逐场景 CSV](examples/three-rounds-v65-v67/metrics.csv) · [第一轮审计](examples/three-rounds-v65-v67/v65/verification.json) · [第二轮审计](examples/three-rounds-v65-v67/v66/verification.json) · [第三轮审计](examples/three-rounds-v65-v67/v67/verification.json) · [验证记录](examples/three-rounds-v65-v67/test-status.json) · [全仓失败名](examples/three-rounds-v65-v67/full-failure-names.json)。每轮子目录保留八源原始压缩结果和运行前代码指纹，历史报告如下保留。

<!-- THREE-ROUNDS-REPORT-END -->

'''
report = docs/'eight-datasets-comparison-report.md'
old = report.read_text()
if old.startswith('<!-- THREE-ROUNDS-REPORT-START -->'): old = old.split('<!-- THREE-ROUNDS-REPORT-END -->\n\n', 1)[1]
report.write_text(text+old)
files = ['src/lib/trace-datasets/sampling/'+n+'.ts' for n in ['budgeted-fast', 'answer-consensus', 'budgeted-agreement']]+['scripts/trace-datasets/'+n for n in ['compare-three-rounds.ts', 'audit-three-rounds.ts', 'benchmark-three-rounds.ts', 'benchmark-three-rounds-synthetic.ts', 'report-three-rounds.py']]+['test/trace-datasets-budgeted-fast.test.ts', 'test/trace-datasets-answer-agreement.test.ts']
(out/'implementation.json').write_text(json.dumps({f: sha(f) for f in files}, indent=2))
print(json.dumps({'rounds': 3, 'passed': summary['passed'], 'report': str(report)}, ensure_ascii=False))
