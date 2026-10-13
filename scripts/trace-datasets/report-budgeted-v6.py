"""Publish audited v6 research results while preserving v4/v5 historical evidence."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
from statistics import mean
import shutil
import sys

root, output = map(Path, sys.argv[1:3])
NAMES = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
MS = dict(zip(NAMES[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
audit = json.loads((root / 'verification.json').read_text())
assert audit['passed'] and audit['datasets'] == 8
reports = {n: json.loads((root / f'{n}.json').read_text()) for n in NAMES}
artifacts = output / 'examples' / 'budgeted-v6'
artifacts.mkdir(parents=True, exist_ok=True)
for n, r in reports.items():
    assert r.get('finishedAt') and not r['plan']['smoke']
    for f, digest in r['plan']['codeHashes'].items():
        assert hashlib.sha256(Path(f).read_bytes()).hexdigest() == digest
    with (artifacts / f'{n}.json.gz').open('wb') as out:
        with gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0) as z:
            z.write((root / f'{n}.json').read_bytes())
for filename in ['plan.json', 'verification.json', 'test-status.json', 'performance-v5.json', 'performance-v6.json', 'performance-long-v5.json', 'performance-long-v6.json']:
    if (root / filename).exists():
        shutil.copyfile(root / filename, artifacts / filename)

primary, flat, quality, sensitivity = [], [], [], []
for name, report in reports.items():
    grouped = {}
    for s in report['scenarios']:
        for method, r in s['methods'].items():
            flat.append(dict(dataset=name, stratum=s['stratum'], population=s['population'], k=s['k'], seed=s['seed'], method=method,
                vocabulary=r['metrics']['vocabulary'], tokens=r['metrics']['tokens'], quality=json.dumps(r['metrics']['quality']), selection_ms=r['selectionMs'], optimization=json.dumps(r.get('optimization'))))
        if s['k'] == 100:
            grouped.setdefault((s['stratum'], s['population']), []).append(s)
        elif s['population'] == 'all':
            sensitivity.append(dict(dataset=name, stratum=s['stratum'], k=s['k'], seed=s['seed'], methods=s['methods']))
    for (stratum, population), trials in grouped.items():
        assert sorted(t['seed'] for t in trials) == [42, 100, 101, 102, 103]
        methods = {m: {key: mean(t['methods'][m]['metrics'][key] for t in trials) for key in ['vocabulary', 'tokens', 'prefix256']} for m in ['B0', 'B4', 'C', 'E1', 'E2', 'E3', 'V6']}
        equal = [r for r in audit['equalBudget'] if (r['dataset'], r['stratum'], r['population'], r['k']) == (name, stratum, population, 100)]
        assert len(equal) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, n=trials[0]['n'], methods=methods,
            equal={m: mean(r[m] for r in equal) for m in ['B0', 'B4', 'C', 'V6']},
            v6feasible=sum(t['methods']['V6']['optimization']['feasible'] for t in trials),
            budgetUsage=mean(t['methods']['V6']['metrics']['tokens']/t['methods']['V6']['optimization']['tokenBudget'] for t in trials),
            selectionMs={m: mean(t['methods'][m]['selectionMs'] for t in trials) for m in ['C', 'V6']},
            swaps=mean(t['methods']['V6']['optimization']['oneSwaps'] + 2*t['methods']['V6']['optimization']['pairSwaps'] for t in trials)))
        for axis in trials[0]['methods']['C']['metrics']['quality']:
            scores = {m: mean(t['methods'][m]['metrics']['quality'][axis]['mean'] for t in trials) for m in ['B0', 'B4', 'C', 'E1', 'E2', 'E3', 'V6']}
            quality.append(dict(dataset=name, stratum=stratum, population=population, axis=axis, **scores))

def label(r):
    return r['dataset'] + (' / '+r['stratum'] if r['stratum'] != 'all' else '')
def change(r, method, metric='vocabulary'):
    return 100*(r['methods'][method][metric]/r['methods']['B0'][metric]-1)
def pct(v): return f'{v:+.1f}%'
def table(headers, rows):
    return '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str, r))+' |' for r in rows])
coverage = [r for r in primary if r['dataset'] in MS and r['population']=='all']
gates = []
for r in coverage:
    gain = change(r, 'V6')
    target = max(MS[r['dataset']] + 5, change(r, 'C'))
    passed = gain >= target and r['equal']['V6'] >= r['equal']['C'] and r['v6feasible'] == 5
    reasons=[]
    if gain < target: reasons.append('覆盖增幅不足')
    if r['equal']['V6'] < r['equal']['C']: reasons.append(f"同 token 比 v5 低 {100*(1-r['equal']['V6']/r['equal']['C']):.2f}%")
    if r['v6feasible'] != 5: reasons.append('存在不可行回退')
    gates.append(dict(condition=label(r)+' / 词汇', value=gain, target=target, passed=passed, reason='；'.join(reasons) or '覆盖、同 token 与成本条件通过'))
main_quality = [r for r in quality if (r['dataset']=='OASST2' and r['population']=='quality-annotated' and r['axis']=='quality') or (r['dataset']=='HelpSteer2' and r['axis']=='helpfulness') or (r['dataset']=='SummarizeFeedback' and r['axis']=='overall')]
for r in main_quality:
    target = max(r['B0'], r['B4']) if r['dataset']=='HelpSteer2' else max(1.1*r['B0'], r['C'])
    gates.append(dict(condition=label(r)+' / '+r['axis'], value=r['V6'], target=target, passed=r['V6']>=target, reason='人工评分低于目标' if r['V6']<target else '评分目标通过'))
assert len(gates)==11
summary = dict(status='offline_candidate_not_enabled', default='trace-coverage-v4', candidate='trace-coverage-v6', primary=primary, quality=quality, gates=gates, passed=sum(g['passed'] for g in gates), confirmation='not_run', msSamePool='unavailable')
(artifacts / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
with (artifacts / 'metrics.csv').open('w', newline='') as out:
    writer=csv.DictWriter(out, fieldnames=flat[0].keys()); writer.writeheader(); writer.writerows(flat)

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots(figsize=(13, 7), layout='constrained')
y=np.arange(len(coverage))
for offset, key, color, title in [(-.27,'MS','#b45309','Microsoft (published)'),(-.09,'B4','#64748b','v4 (default)'),(.09,'C','#4f46e5','v5 (disabled)'),(.27,'V6','#0f766e','v6 (offline candidate)')]:
    values=[MS[r['dataset']] if key=='MS' else change(r,key) for r in coverage]
    bars=ax.barh(y+offset, values, height=.17, color=color, label=title)
    ax.bar_label(bars, labels=[f'{v:+.1f}%' for v in values], padding=3, fontsize=8)
ax.set_yticks(y,[r['dataset'] for r in coverage]); ax.invert_yaxis(); ax.axvline(0,color='#333333',linewidth=.8)
ax.grid(axis='x',alpha=.2); ax.set_axisbelow(True); ax.margins(x=.15)
ax.set_xlabel('Distinct input vocabulary uplift over each experiment\'s random baseline (%)')
ax.set_title('Microsoft vs v4 / v5 / v6\nMicrosoft uses a different pool/protocol: numerical targets, NOT a head-to-head result')
ax.legend(loc='lower left',fontsize=9)
fig.savefig(artifacts/'microsoft-v4-v5-v6.png',dpi=170); fig.savefig(artifacts/'microsoft-v4-v5-v6.svg',metadata={'Date':None}); plt.close(fig)

coverage_table=table(['数据集','微软公开','默认 v4','候选 v5','离线 v6','v6 − 微软（百分点）','本轮门槛'],[[r['dataset'],pct(MS[r['dataset']]),pct(change(r,'B4')),pct(change(r,'C')),pct(change(r,'V6')),f"{change(r,'V6')-MS[r['dataset']]:+.1f}",'通过' if gates[i]['passed'] else '未通过'] for i,r in enumerate(coverage)])
quality_table=table(['数据 / 人工评分','微软公开增幅','随机均值','v4 均值','v5 均值','v6 均值','v6 对随机','本轮目标均值'],[[label(r)+' / '+r['axis'], '+8.1%' if r['dataset']=='OASST2' else '-9.7%' if r['dataset']=='HelpSteer2' else '未单列；总体 +8.3%',*[f'{r[m]:.3f}' for m in ['B0','B4','C','V6']],pct(100*(r['V6']/r['B0']-1)),f"{gates[6+i]['target']:.3f}"] for i,r in enumerate(main_quality)])
gate_table=table(['验收条件','v6 实测','目标','状态','依据'],[[g['condition'],f"{g['value']:.3f}",f"≥ {g['target']:.3f}",'通过' if g['passed'] else '未通过',g['reason']] for g in gates])
all_primary=[r for r in primary if r['population']=='all']
cost_table=table(['数据及分层','v6 对随机覆盖','同 token：v6 对 v5','v6 token 对随机','预算利用率','可行 / 5','v6 / v5 选样耗时'],[[label(r),pct(change(r,'V6')),pct(100*(r['equal']['V6']/r['equal']['C']-1)),f"{r['methods']['V6']['tokens']/r['methods']['B0']['tokens']:.3f}×",f"{100*r['budgetUsage']:.1f}%",f"{r['v6feasible']} / 5",f"{r['selectionMs']['V6']/r['selectionMs']['C']:.2f}×"] for r in all_primary])
ablation_table=table(['数据及分层','v5','E1 总预算构造','E2 加一换一','E3 加多起点/二换二','v6 加分布约束'],[[label(r),*[pct(change(r,m)) for m in ['C','E1','E2','E3','V6']]] for r in all_primary])
ablation_quality=table(['数据 / 质量','v5','E1','E2','E3','v6'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.3f}' for m in ['C','E1','E2','E3','V6']]] for r in main_quality])
ablation_cost=table(['数据及分层','E1 token / 随机','E2','E3','v6'],[[label(r),*[f"{r['methods'][m]['tokens']/r['methods']['B0']['tokens']:.3f}×" for m in ['E1','E2','E3','V6']]] for r in all_primary])
guards=[r for r in quality if (r['dataset']=='HelpSteer2' and r['axis']=='correctness') or (r['dataset']=='SummarizeFeedback' and r['axis'] in ['accuracy','coverage','coherence'])]
guard_table=table(['质量防退步轴','随机','v4','v5','v6','v6 − 随机'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.3f}' for m in ['B0','B4','C','V6']],f"{r['V6']-r['B0']:+.3f}"] for r in guards])
sensitive_table=table(['数据及分层','K（seed=42）','v5 覆盖 / 随机','v6 覆盖 / 随机','v6 预算是否可行'],[[label(r),r['k'],pct(100*(r['methods']['C']['metrics']['vocabulary']/r['methods']['B0']['metrics']['vocabulary']-1)),pct(100*(r['methods']['V6']['metrics']['vocabulary']/r['methods']['B0']['metrics']['vocabulary']-1)),'是' if r['methods']['V6']['optimization']['feasible'] else '否，回退 v4'] for r in sensitivity])
curves=[]
for name,r in reports.items():
    for s in r['scenarios']:
        if s['seed']!=42 or s['k']!=100 or s['population']!='all': continue
        for m in ['V6_1','V6','V6_1.2']:
            run=s['methods'][m]; o=run['optimization']
            curves.append([name+(' / '+s['stratum'] if s['stratum']!='all' else ''), m, pct(100*(run['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)), f"{run['metrics']['tokens']/o['baseTokens']:.3f}×",'是' if o['feasible'] else '否，回退 v4'])
curve_table=table(['数据及分层','预算档','覆盖 / 随机','实际 token / B_ref','是否可行'],curves)
feasible=[r for r in audit['constraints'] if r['method']=='V6']
fail=sum(not r['feasible'] for r in feasible)
noise=[r for r in audit['noise'] if r['method']=='V6' and r['k']==100]
noise_max=max(r['longAlphanumericTerms']/max(1,r['longAlphanumericTerms']+r['vocabularyWithoutLongAlphanumeric']) for r in noise)
performance_rows=[]
performance_verdicts=[]
for suffix, title in [('', 'N=10,000 / 短输入'), ('long-', 'N=1,000 / 2,048 额外词项长输入')]:
    files=[root/f'performance-{suffix}{v}.json' for v in ['v5','v6']]
    if not all(f.exists() and f.stat().st_size for f in files): continue
    a,b=[json.loads(f.read_text()) for f in files]
    assert a['hardware']==b['hardware']
    for report in [a,b]:
        for file,digest in report['codeHashes'].items(): assert hashlib.sha256(Path(file).read_bytes()).hexdigest()==digest
    for x,y in zip(a['measurements'],b['measurements']):
        assert x['n']==y['n'] and x['k']==y['k'] and x['count']==y['count']
        if x['k']==500:
            ratio=y['selectionMs']/x['selectionMs']
            performance_verdicts.append(f"{title} / K=500 的选样耗时为 v5 的 {ratio:.2f} 倍，{'未满足' if ratio>3 else '满足'} 3 倍耗时门槛。")
        performance_rows.append([title,x['k'],f"{x['selectionMs']/1000:.3f}s",f"{y['selectionMs']/1000:.3f}s",f"{y['selectionMs']/x['selectionMs']:.2f}×",f"{x['maxRssKiB']/1024:.1f} / {y['maxRssKiB']/1024:.1f}",f"{x['additionalHighWaterKiB']/1024:.1f} / {y['additionalHighWaterKiB']/1024:.1f}"])
performance_table=table(['隔离合成场景','K','v5 选样','v6 选样','耗时倍数','进程峰值 MiB v5 / v6','特征完成后的高水位增量 MiB v5 / v6'],performance_rows) if performance_rows else '隔离合成性能测试尚未完成。'
tests=json.loads((root/'test-status.json').read_text())
test_summary=f"专项 {tests['targeted']['pass']}/{tests['targeted']['tests']} 通过；源码及研究脚本类型检查通过。全仓 {tests['full']['tests']} 项，{tests['full']['pass']} 通过、{tests['full']['fail']} 失败、{tests['full']['skipped']} 跳过，全仓未通过。新增观测到的 Pi 模型发现失败在单文件重跑通过，其余失败本轮未逐项归因。"
implementation={file:hashlib.sha256(Path(file).read_bytes()).hexdigest() for file in ['src/lib/trace-datasets/sampling/budgeted.ts','scripts/trace-datasets/compare-budgeted-v6.ts','scripts/trace-datasets/audit-budgeted-v6.ts','scripts/trace-datasets/report-budgeted-v6.py','scripts/trace-datasets/benchmark-budgeted.ts','test/trace-datasets-budgeted.test.ts']}
(artifacts/'implementation.json').write_text(json.dumps(implementation,indent=2))
section=f'''<!-- V6-REPORT-START -->
## v6 优化实测：已实现离线候选，默认继续使用 v4

**本轮 11 个主要条件通过 {summary['passed']} 个，尚未达到“所有数据集都超过微软公开数值并满足质量与成本门槛”的目标。** v6 已完成全局预算、最多八个固定起点、一换一/有限二换二、长度/任务分布约束及显式回退。没有使用 LLM、人工评分选样或新增 Trace 存储字段。当前仅供离线实验，未接入生产 Worker 或 Web UI。

### 先看微软、v4、v5、v6 的直接差异

以下均为词汇覆盖相对各自随机基线的增幅。本地三版使用相同冻结池、K=100、五种子。微软值来自[微软公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)，**不同数据池/切分口径，只能作数值目标对照，不能认定击败微软算法**。门槛同时要求微软值＋5 个百分点、不低于 v5、同 token 审计不退步、所有五次预算可行。

{coverage_table}

![微软公开与 v4/v5/v6 的直接对照](examples/budgeted-v6/microsoft-v4-v5-v6.png)

### 人工质量没有由词汇覆盖自动保证

{quality_table}

OASST2 使用 quality 有标注子池；摘要各层分别统计，不将微软总体值伪装成各层官方值。OASST2 和摘要的内部目标是至少比随机高 10%；HelpSteer2 要求 helpfulness 不低于随机与 v4。人工标签仅在入选 ID 冻结后统计。即使数值超过微软所报告的 HelpSteer2 下降幅度，仍不能绕过本地质量门槛。

{gate_table}

前六行单位为覆盖增幅百分数，后五行是原始人工评分。这里是已知回归集的点估计状态；通过也不等于独立确认或生产放行。

### 成本、同预算与速度

{cost_table}

预算为 `floor(1.10 × min(K,N) × 全池独立输入平均词法 token 数)`，包含回答变体重复输入的实际成本。上表 token / 随机与预算利用率分母不同，不应混用。token 是词法计数，不是模型计费 token。同 token 指 B0/v4/v5/v6 取最小总量、固定哈希顺序、末条仅在指标审计时截断，未更改输出原文。

全部 {len(feasible)} 个 v6 场景中有 {fail} 个未找到可行解并明确回退 v4；回退结果不计作 v6 预算达标。选样耗时包含 v5 初解、构造和替换；公开数据运行与部分仓库测试存在重叠，耗时只作诊断，不能作隔离性能验收。独立进程合成性能记录见下方证据；完整四 Worker 并发/发布/取消仍未验收。

{performance_table}

{' '.join(performance_verdicts)}

合成基准按 v5、v6 独立进程串行运行；公开数据实验和全仓测试完成后才开始。短输入覆盖 N=10k/K=500，长输入覆盖 N=1k/K=500；特征/签名耗时单列在 JSON。高水位增量是该进程特征构建后、跨 K 顺序累计的 RSS 高水位变化，不等同精确分配峰值，不能单凭它证明增量内存门槛。只有一轮合成运行，完整四 Worker 并发、真实来源读取/发布和取消仍缺证据，尚不构成生产性能验收。

[v5 短输入](examples/budgeted-v6/performance-v5.json) · [v6 短输入](examples/budgeted-v6/performance-v6.json) · [v5 长输入](examples/budgeted-v6/performance-long-v5.json) · [v6 长输入](examples/budgeted-v6/performance-long-v6.json)

### 消融：每一步同时看覆盖、质量、成本

{ablation_table}

{ablation_quality}

{ablation_cost}

E1 保留可行 v5 初解，另加一个全局预算覆盖构造，关闭分布约束；它不仅改预算，也改变构造和确定性顺序，不是严格单因素因果实验。E2 在 E1 上加一换一；E3 开启固定多起点和有限二换二；v6 再加长度/任务 TV 约束。各方法均独立重跑，未按数据集选择算法或最好种子；预算与配置失败可在原始结果看到。无收益的额外搜索不会仅因覆盖改善就视为值得上线。

### 质量防退步、输出规模与预算敏感性

{guard_table}

{sensitive_table}

以下仅 seed=42、K=100。V6_1 / V6 / V6_1.2 分别为 1.00 / 1.10 / 1.20 倍 B_ref；1.20 档的收益不能算作 1.10 档通过。

{curve_table}

### 证据、局限与下一阶段

{test_summary}

- 独立脚本从原始文本重新核对 {audit['scenarios']} 个场景、{audit['selectedItems']:,} 个入选项、{audit['qualityMeans']:,} 个人工均值，以及 v6 成本、词汇、长度/任务 TV。v4 的 K=100、v5 的全部入选 ID 与历史记录逐项一致。
- 长度 ≥24 且同时含字母数字的词项只作噪声诊断，未参与选样；v6 主场景这类词项占比最高 {100*noise_max:.2f}%。这不是完整噪声检测，也没有验证重复模板的全部贡献，不构成语义覆盖证明。
- 沿用已经看过的八源池，未取得全新来源组确认集、未计算独立泛化显著性、未运行微软官方算法同池比较。当前失败项不能通过改称“独立验证”消失；启发式未达标也不证明预算下数学不可达。
- 按优化方案保留 v4 默认。v6 尚未进入生产版本分派，本轮未在浏览器中验证；前版 v4 浏览器证据保留在后文，不代表 v6 已通过 Web UI。

[机器可读汇总](examples/budgeted-v6/summary.json) · [全部指标 CSV](examples/budgeted-v6/metrics.csv) · [独立审计](examples/budgeted-v6/verification.json) · [冻结协议](examples/budgeted-v6/plan.json) · [测试记录](examples/budgeted-v6/test-status.json) · [算法实现](../../../src/lib/trace-datasets/sampling/budgeted.ts) · [优化方案与阶段状态](sampling-v6-optimization-plan.md)

复现：`compare-budgeted-v6.ts <原始映射数据> <冻结v4目录> <冻结v5目录> <新输出目录>`；完成后运行 `audit-budgeted-v6.ts`（相同四个路径），最后 `python3 scripts/trace-datasets/report-budgeted-v6.py <新输出目录> docs/design/trace-eval-dataset`。结果、审计与代码指纹必须一致；单独归档的 JSON.gz 保留每次入选 ID。比较脚本使用 `node --import tsx`，作图使用现有临时 matplotlib 环境，不增加项目依赖。

以下是 v4/v5 历史比较及其当时的验证记录；当前状态以上述 v6 章节为准。
<!-- V6-REPORT-END -->
'''
report_file=output/'eight-datasets-comparison-report.md'
text=report_file.read_text()
if '<!-- V6-REPORT-START -->' in text:
    start=text.index('<!-- V6-REPORT-START -->'); end=text.index('<!-- V6-REPORT-END -->')+len('<!-- V6-REPORT-END -->')
    text=text[:start]+text[end:].lstrip('\n')
first, rest=text.split('\n',1)
report_file.write_text(first+'\n\n'+section+'\n'+rest.lstrip('\n'))
print(json.dumps({'gatesPassed':summary['passed'],'gates':11,'scenarios':audit['scenarios'],'fallbacks':fail}))
