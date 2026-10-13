"""Append audited v6.1 follow-up evidence without rewriting earlier experiments."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
from statistics import mean
import shutil
import sys

root, output = map(Path, sys.argv[1:3])
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
audit = json.loads((root/'verification.json').read_text())
assert audit['passed'] and audit['datasets']==8
reports = {n:json.loads((root/f'{n}.json').read_text()) for n in names}
artifacts=output/'examples'/'budgeted-v61'; artifacts.mkdir(parents=True, exist_ok=True)
for name,report in reports.items():
    assert report.get('finishedAt') and not report['plan']['smoke']
    for file,digest in report['plan']['codeHashes'].items(): assert hashlib.sha256(Path(file).read_bytes()).hexdigest()==digest
    with (artifacts/f'{name}.json.gz').open('wb') as out:
        with gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0) as z: z.write((root/f'{name}.json').read_bytes())
for file in ['plan.json','verification.json','test-status.json',*[f'performance-{s}{v}.json' for s in ['', 'long-'] for v in ['v5','v6','v61']]]:
    assert (root/file).exists() and (root/file).stat().st_size, file
    shutil.copyfile(root/file,artifacts/file)
primary=[]; quality=[]; flat=[]; sensitivity=[]
methods=['B0','B4','C','V6','FAST','REPAIR','V61']
for name,report in reports.items():
    grouped={}
    for s in report['scenarios']:
        for method,run in s['methods'].items():
            flat.append(dict(dataset=name,stratum=s['stratum'],population=s['population'],k=s['k'],seed=s['seed'],method=method,vocabulary=run['metrics']['vocabulary'],tokens=run['metrics']['tokens'],quality=json.dumps(run['metrics']['quality']),selection_ms=run['selectionMs'],optimization=json.dumps(run.get('optimization'))))
        if s['k']==100: grouped.setdefault((s['stratum'],s['population']),[]).append(s)
        elif s['population']=='all': sensitivity.append(dict(dataset=name,**s))
    for (stratum,population),trials in grouped.items():
        assert sorted(t['seed'] for t in trials)==[42,100,101,102,103]
        equal=[e for e in audit['equalBudget'] if (e['dataset'],e['stratum'],e['population'],e['k'])==(name,stratum,population,100)]
        assert len(equal)==5
        r=dict(dataset=name,stratum=stratum,population=population,n=trials[0]['n'],methods={m:{key:mean(t['methods'][m]['metrics'][key] for t in trials) for key in ['vocabulary','tokens','prefix256']} for m in methods},equal={m:mean(e[m] for e in equal) for m in ['B0','B4','C','V6','V61']},feasible=sum(t['methods']['V61']['optimization']['feasible'] for t in trials),selectionMs={m:mean(t['methods'][m]['selectionMs'] for t in trials) for m in ['C','FAST','REPAIR','V61']})
        primary.append(r)
        for axis in trials[0]['methods']['C']['metrics']['quality']:
            quality.append(dict(dataset=name,stratum=stratum,population=population,axis=axis,**{m:mean(t['methods'][m]['metrics']['quality'][axis]['mean'] for t in trials) for m in methods}))

def label(r): return r['dataset']+(' / '+r['stratum'] if r['stratum']!='all' else '')
def pct(x): return f'{x:+.1f}%'
def gain(r,m): return 100*(r['methods'][m]['vocabulary']/r['methods']['B0']['vocabulary']-1)
def table(headers,rows): return '\n'.join(['| '+' | '.join(headers)+' |','| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str,row))+' |' for row in rows])
coverage=[r for r in primary if r['population']=='all' and r['dataset'] in ms]
qmain=[r for r in quality if (r['dataset']=='OASST2' and r['population']=='quality-annotated' and r['axis']=='quality') or (r['dataset']=='HelpSteer2' and r['axis']=='helpfulness') or (r['dataset']=='SummarizeFeedback' and r['axis']=='overall')]
gates=[]
for r in coverage:
    value=gain(r,'V61'); target=max(ms[r['dataset']]+5,gain(r,'C')); reasons=[]
    if value<target: reasons.append('覆盖不足')
    if r['equal']['V61']<r['equal']['C']: reasons.append('同 token 覆盖低于 v5')
    if r['feasible']!=5: reasons.append('有不可行回退')
    gates.append(dict(condition=label(r)+' / 词汇',value=value,target=target,passed=not reasons,reason='；'.join(reasons) or '覆盖/成本条件通过'))
for r in qmain:
    target=max(r['B0'],r['B4']) if r['dataset']=='HelpSteer2' else max(r['B0']*1.1,r['C'])
    gates.append(dict(condition=label(r)+' / '+r['axis'],value=r['V61'],target=target,passed=r['V61']>=target,reason='人工评分不足' if r['V61']<target else '人工评分目标通过'))
assert len(gates)==11
summary=dict(status='offline_not_enabled',default='trace-coverage-v4',candidate='trace-coverage-v6.1',primary=primary,quality=quality,gates=gates,passed=sum(g['passed'] for g in gates),independentConfirmation='not_run')
(artifacts/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
with (artifacts/'metrics.csv').open('w',newline='') as out:
    writer=csv.DictWriter(out,fieldnames=flat[0]);writer.writeheader();writer.writerows(flat)

coverage_table=table(['数据集','微软公开','默认 v4','v5','v6','v6.1','v6.1 − 微软（百分点）'],[[r['dataset'],pct(ms[r['dataset']]),*[pct(gain(r,m)) for m in ['B4','C','V6','V61']],f"{gain(r,'V61')-ms[r['dataset']]:+.2f}"] for r in coverage])
quality_table=table(['数据 / 评分','微软公开增幅','随机','v4','v5','v6','v6.1','v6.1 − v6'],[[label(r)+' / '+r['axis'],'+8.1%' if r['dataset']=='OASST2' else '-9.7%' if r['dataset']=='HelpSteer2' else '仅总体 +8.3%，无此分层',*[f'{r[m]:.3f}' for m in ['B0','B4','C','V6','V61']],f"{r['V61']-r['V6']:+.3f}"] for r in qmain])
gate_table=table(['条件','v6.1 实测','目标下限','状态 / 原因'],[[g['condition'],f"{g['value']:.3f}",f"{g['target']:.3f}",('通过：' if g['passed'] else '未通过：')+g['reason']] for g in gates])
primary_all=[r for r in primary if r['population']=='all']
ablation_table=table(['数据及分层','v6 / FAST 覆盖增幅','REPAIR 覆盖增幅','v6.1 覆盖增幅','同 token：v6.1 对 v5','同 token：v6.1 对 v6','v6.1 token / 随机'],[[label(r),pct(gain(r,'V6')),pct(gain(r,'REPAIR')),pct(gain(r,'V61')),pct(100*(r['equal']['V61']/r['equal']['C']-1)),pct(100*(r['equal']['V61']/r['equal']['V6']-1)),f"{r['methods']['V61']['tokens']/r['methods']['B0']['tokens']:.3f}×"] for r in primary_all])
ablation_quality=table(['数据 / 评分','FAST','REPAIR','v6.1'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.3f}' for m in ['FAST','REPAIR','V61']]] for r in qmain])
ablation_cost=table(['数据及分层','FAST token / B0','REPAIR','v6.1'],[[label(r),*[f"{r['methods'][m]['tokens']/r['methods']['B0']['tokens']:.3f}×" for m in ['FAST','REPAIR','V61']]] for r in primary_all])
sensitivity_table=table(['数据及分层','K（seed=42）','v6 覆盖 / 随机','v6.1 覆盖 / 随机','v6 可行','v6.1 可行'],[[label(s),s['k'],*[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in ['V6','V61']],*[str(s['methods'][m]['optimization']['feasible']) for m in ['V6','V61']]] for s in sensitivity])
performance=[]; performance_rows=[]
for suffix,title in [('', 'N=10k 短输入'),('long-', 'N=1k 长输入')]:
    runs={v:json.loads((root/f'performance-{suffix}{v}.json').read_text()) for v in ['v5','v6','v61']}
    assert runs['v5']['hardware']==runs['v6']['hardware']==runs['v61']['hardware']
    for r in runs.values():
        for f,h in r['codeHashes'].items(): assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h
    for i in range(3):
        x={v:r['measurements'][i] for v,r in runs.items()};k=x['v5']['k']
        assert all(r['count']==min(k,r['n']) and r['k']==k for r in x.values())
        ratio=x['v61']['selectionMs']/x['v5']['selectionMs']
        row=dict(scenario=title,k=k,runs=x,ratioToV5=ratio,ratioToV6=x['v61']['selectionMs']/x['v6']['selectionMs'],timeGate=ratio<=3)
        performance.append(row)
        performance_rows.append([title,k,*[f"{x[v]['selectionMs']/1000:.3f}s" for v in ['v5','v6','v61']],f'{ratio:.2f}×',f"{100*(1-row['ratioToV6']):.1f}%",'通过' if ratio<=3 else '未通过'])
(artifacts/'performance-summary.json').write_text(json.dumps(performance,indent=2))
performance_table=table(['隔离合成场景','K','v5','v6','v6.1','v6.1 / v5','较 v6 缩短','3 倍耗时门槛'],performance_rows)
memory_table=table(['场景','K','v5 / v6 / v6.1 进程峰值 MiB','v5 / v6 / v6.1 高水位增量 MiB'],[[p['scenario'],p['k'],' / '.join(f"{p['runs'][v]['maxRssKiB']/1024:.1f}" for v in ['v5','v6','v61']),' / '.join(f"{p['runs'][v]['additionalHighWaterKiB']/1024:.1f}" for v in ['v5','v6','v61'])] for p in performance])
guards=[r for r in quality if (r['dataset']=='HelpSteer2' and r['axis']=='correctness') or (r['dataset']=='SummarizeFeedback' and r['axis'] in ['accuracy','coverage','coherence'])]
guard_table=table(['防退步轴','随机','v4','v5','v6','v6.1'],[[label(r)+' / '+r['axis'],*[f'{r[m]:.3f}' for m in ['B0','B4','C','V6','V61']]] for r in guards])
curves=[]
for name,report in reports.items():
    for s in report['scenarios']:
        if s['seed']!=42 or s['k']!=100 or s['population']!='all':continue
        for m in ['V61_1','V61','V61_1.2']:
            run=s['methods'][m];o=run['optimization'];curves.append([label(dict(dataset=name,**s)),m,pct(100*(run['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)),f"{run['metrics']['tokens']/o['baseTokens']:.3f}×",str(o['feasible'])])
curve_table=table(['数据及分层','预算档','覆盖 / 随机','token / B_ref','可行'],curves)
fallbacks=[c for c in audit['constraints'] if c['method']=='V61' and not c['feasible']]

audit_source=Path('scripts/trace-datasets/audit-refined-v61.ts');assert hashlib.sha256(audit_source.read_bytes()).hexdigest()==audit['auditorSha256']
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig,ax=plt.subplots(figsize=(14,8),layout='constrained'); y=np.arange(6)
for offset,m,color,title in [(-.32,'MS','#b45309','Microsoft (published)'),(-.16,'B4','#64748b','v4 (default)'),(0,'C','#4f46e5','v5'),(.16,'V6','#0f766e','v6'),(.32,'V61','#0369a1','v6.1 (offline)')]:
    vals=[ms[r['dataset']] if m=='MS' else gain(r,m) for r in coverage]
    bars=ax.barh(y+offset,vals,height=.15,color=color,label=title);ax.bar_label(bars,labels=[f'{v:+.1f}%' for v in vals],padding=3,fontsize=8)
ax.set_yticks(y,[r['dataset'] for r in coverage]);ax.invert_yaxis();ax.axvline(0,color='#333333',linewidth=.8);ax.grid(axis='x',alpha=.2);ax.set_axisbelow(True);ax.margins(x=.15)
ax.set_xlabel('Distinct input vocabulary uplift over each experiment\'s random baseline (%)');ax.set_title('Microsoft vs v4 / v5 / v6 / v6.1\nDifferent Microsoft pool/protocol: numerical target comparison, NOT head-to-head validation');ax.legend(loc='lower left',fontsize=8)
fig.savefig(artifacts/'comparison.png',dpi=170);fig.savefig(artifacts/'comparison.svg',metadata={'Date':None});plt.close(fig)

status=json.loads((root/'test-status.json').read_text());t=status['targeted'];f=status['full']
text=f'''<!-- V61-REPORT-START -->
## v6.1 继续优化：加速、修复可行性、扩大交换候选

**当前仍使用 v4；v6.1 为离线候选。11 项主要效果条件通过 {summary['passed']} 项，未完成全部目标。** 本轮保留 v6 的全部历史结果与源码，新增单独版本；没有调用 LLM，没有增加生产 Trace 存储，也没有放宽覆盖、质量、预算与分布门槛。

本轮 Dolly、ShareGPT4 通过覆盖与成本条件；WildChat 的原始覆盖虽提高，同 token 覆盖仍低于 v5。NoRobots、OASST2、UltraChat 的覆盖以及五项质量条件仍未达标。UltraChat 四舍五入后与微软均为 +49.3%，实际为 +49.277%，不能算超过微软公开值。

### 微软与本地各版本直接对照

{coverage_table}

以上为不同输入词项数相对各自随机基线的增幅，本地 K=100、固定五种子、相同冻结池。微软来自[公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)；不同池、分词和处理协议，不能据此声称击败微软算法。旧 v4/v5/v6 均保留原始 ID，本地 FAST 分支逐次回放 v6 ID 一致。

![微软、v4、v5、v6、v6.1 对照](examples/budgeted-v61/comparison.png)

### 质量与逐项门槛

{quality_table}

原始人工评分仅在选样后统计，未传给采样器。OASST2 用质量标注子池；摘要不合并三个原始分层，也不把微软总体值填到各层。所有质量下降均保留，不能用词汇提高抵消。

{gate_table}

前六项单位为覆盖增幅百分数；同时要求不低于 v5、同 token 覆盖不退步、预算可行。后五项为原始人工均值。这里的通过仅是已知回归池的点估计，不代表独立确认或生产放行。质量防退步轴另列在下方。

### 性能：相同合成池、独立进程串行测量

{performance_table}

{memory_table}

三版本均在公开数据实验和全仓测试结束后串行执行，包含各自完整选样路径；特征/MinHash 计算耗时另存原始 JSON，表中为采样耗时。一轮基准不能代表所有生产负载。RSS 高水位增量是在特征构造后跨 K 累计的高水位变化，不等同准确的新增分配量；完整四 Worker、真实来源读取/发布/取消仍待验证。

### 改了什么，收益来自哪里

1. **FAST**：长度/任务约束按每一步预计算，稳定排序转换为整数排名；词项增减复用有符号计数数组，跳过不可能增加词汇的交换。保留 v6 的排名种子协议。全部 {audit['scenarios']} 个场景与 v6 入选 ID 一致，证明加速没有靠改变样本换取时间。
2. **REPAIR**：对完整但违反预算或分布的初解，尝试最多 min(K,32) 次修复；每次严格减少总约束超额，保留必要任务与真实行为格子。修复阶段允许降低覆盖来恢复可行性，可行后再做正收益搜索。它是有界启发式，失败不证明数学不可行。
3. **v6.1**：在最佳可行解后，再用词汇/成本效率及原始增量各取一部分加入候选，同时考虑低覆盖损失和高成本的移除候选；最多两轮，只有覆盖严格提高且所有约束仍满足才替换。没有数据源专用规则、质量分数或最好种子挑选。

{ablation_table}

{ablation_quality}

{ablation_cost}

同 token 指五方法在每次试验的最小总输入词法 token 数，固定哈希顺序读取、最后一条只在指标计算中截断；原文未改变。这不是模型计费 token。主预算仍是 `floor(1.10 × min(K,N) × 独立输入平均词法 token 数)`；随机样本成本与全池均值有差异，token/B0 不应当作预算利用率。

### 小样本、质量防退步与预算敏感性

{sensitivity_table}

全部 {audit['scenarios']} 个 v6.1 场景有 {len(fallbacks)} 次显式回退；所有回退照实保留，不能计作候选策略达标。K=20/500 仅 seed=42，不能代替更多来源的确认。

{guard_table}

{curve_table}

V61_1 / V61 / V61_1.2 分别为 1.00/1.10/1.20 倍预算，预算曲线仅 seed=42、K=100；1.20 档收益不计为主门槛通过。

### 验证与剩余工作

专项 {t['pass']}/{t['tests']} 通过；源码与研究脚本类型检查通过。全仓 {f['tests']} 项，{f['pass']} 通过、{f['fail']} 失败、{f['skipped']} 跳过，全仓未通过。失败对照及重跑记录见测试文件，不把专项通过写成全仓通过。

独立复算核对 {audit['selectedItems']:,} 个入选项、{audit['qualityMeans']:,} 个人工均值，以及预算、词汇、分布和回退；FAST 入选 ID 与冻结 v6 逐项一致，v6 原本可行时，v6.1 的原始词汇覆盖不低于它。词项/词法长度仍只是可测代理，不等于语义覆盖或回答正确性。

当前没有新的来源组独立确认、微软官方算法同池对照或完整生产压力证据。v6.1 未接入 Worker/API，因此本轮未在浏览器中验证；历史 v4 浏览器证据不代表新版验收。用户操作与用户指南不变。

[汇总](examples/budgeted-v61/summary.json) · [逐次指标 CSV](examples/budgeted-v61/metrics.csv) · [独立审计](examples/budgeted-v61/verification.json) · [冻结协议](examples/budgeted-v61/plan.json) · [性能汇总](examples/budgeted-v61/performance-summary.json) · [测试记录](examples/budgeted-v61/test-status.json) · [源码](../../../src/lib/trace-datasets/sampling/budgeted-refined.ts)

复现：`node --import tsx scripts/trace-datasets/compare-refined-v61.ts <data> <v4目录> <v5目录> <v6目录> <新输出目录>`，之后用相同路径执行 `audit-refined-v61.ts`。`benchmark-refined.ts --v5/--v6` 或不加版本参数分别测三版，`--long` 测长输入。最后执行 `report-refined-v61.py <新输出目录> docs/design/trace-eval-dataset`。研究脚本可在系统临时目录复用带输入/协议哈希及校验和的签名，不进入生产数据目录；新八源运行输出独立于历史目录。

以下保留前轮报告和验收记录，当前状态以上述章节为准。
<!-- V61-REPORT-END -->
'''
file=output/'eight-datasets-comparison-report.md';old=file.read_text()
if '<!-- V61-REPORT-START -->' in old:
    a=old.index('<!-- V61-REPORT-START -->');b=old.index('<!-- V61-REPORT-END -->')+len('<!-- V61-REPORT-END -->');old=old[:a]+old[b:].lstrip('\n')
first,rest=old.split('\n',1);file.write_text(first+'\n\n'+text+'\n'+rest.lstrip('\n'))
source_files=['src/lib/trace-datasets/sampling/budgeted-refined.ts','scripts/trace-datasets/compare-refined-v61.ts','scripts/trace-datasets/audit-refined-v61.ts','scripts/trace-datasets/benchmark-refined.ts','scripts/trace-datasets/report-refined-v61.py','test/trace-datasets-budgeted-refined.test.ts']
(artifacts/'implementation.json').write_text(json.dumps({f:hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in source_files},indent=2))
print(json.dumps({'passed':summary['passed'],'total':11,'fallbacks':len(fallbacks)}))
