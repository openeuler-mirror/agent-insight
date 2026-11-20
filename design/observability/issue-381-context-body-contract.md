# Issue 381 上下文正文接口与存储设计

> 历史实验记录：本文件保留早期增强成员采集和正文实验，不是当前第一版的功能承诺。当前 collector 不注册请求成员采样，Trace 不启用成员差异回退。当前范围、版本和限制以[已有数据设计](issue-381-existing-source-v1.md)及[草稿 PR 验收报告](issue-381-pr-acceptance.md)为准；下文阶段性全通过或自动裁剪结论不能迁移为当前版本全部验收通过。

## 需求分析

请求成员清单必须绑定原生请求和响应事件。正文需要独立于长期 Trace 事件保存，避免到期后仍可从原始事件读取。读取沿用所属 Trace 的权限；缺失正文不得按历史请求原文展示。

## 接口设计

沿用认证的 OTLP Logs 入口。assistant/message 的 contextMembership 包含 schemaVersion 1、attemptId、sourceSessionId、response、items 和 expiresAt。仅接受 sourceSessionId 与响应源会话一致、response.eventSequence 与事件序号一致的 bound 清单。采集器默认不上传正文；DSH_CAPTURE_BODIES 和 DSH_UPLOAD_BODIES 使用 AGENT_INSIGHT_ 前缀，分别控制本地采集与平台上传。

平台在事件落盘前分离 items.text，正文写入独立私有目录；事件及数据库仅保留成员元数据、状态与 bodyRef。GET /api/observe/session 增加 view=context-body、sourceSessionId、contextRequestId 查询参数。先完成现有 Trace 授权，再验证请求属于该 Trace；无正文或过期返回 410，且禁止缓存正文响应。

## 容量和保留

每条成员正文最多 8192 UTF8 字节，每请求正文合计最多 262144 字节，清单最多 4096 项。正文文件连同元数据每会话最多 1048576 字节，平台目录最多 268435456 字节且最多 4096 份文件。跨进程互斥完成容量检查及写入；并发锁冲突重试上报。重复 attemptId 不重复占用配额。正文保存至采集端 expiresAt，且最多为接收后七天；读取立即拒绝过期数据，现有 runtime cleanup 调度执行物理删除。关闭清理或 dry run 不延长读取期限，但可能延迟物理删除。

## 开发与验收

实现独立正文存储、OTLP 分离、现有 session 接口读取、runtime cleanup 类别和按需 UI。自动验证超限、并发、隔离、去重、过期拒读及删除；真实会话验证 Tool Skill 子 Agent 及逐请求正文。有效归属的崩溃遗留锁和恢复声明现已接入自动回收；未知或旧格式仍拒写，不允许按锁龄直接抢锁。

## 分类趋势、差异与兼容性（2026-11-18）

清单补采 tokenEstimate（回退口径）使用与当前 Harness 同源的公开 @deepseek-ai/dsh-token-meter/estimate；按 message/tools/system 结构分配分类估算。basis=captured-canonical-request-before-provider-adaptation，approximate=true。缺失估算不填零；providerUsage 仅从源 response.usage 读取，未缓存输入、输出、缓存读取分别展示。面板按源会话绘制类别大小，间断请求不连线。相邻差异按 itemId 与完整脱敏指纹计算，列出新增、移除、变化；无清单、身份歧义或截断会明确限制，不能视为精确历史 wire 差异。

原生 compaction/start、summary、end、prune 和 model/selection 的源 seq 与下一响应关联。单个原始事件可以与压缩后的首请求对应，但不能按时间猜测内容来源。正文来源没有事件号时显示未提供。正文读取要求有效 resolveUser 身份，拒绝仅 user 查询参数模拟身份。

同会话真实验收：161→181 压缩后 +6/−43/Δ0，原公开 API 约束在两份正文均可见；184 切至 Pro 后响应195，199恢复 Flash 后响应210；prune222替换工具结果214为223（12017→5159字符）。232受旧配额故障缺失清单，不能声称精确相邻裁剪差异。修复配额降级后244、253、263正常上报；263正文 quota-omitted，但成员指纹与223一致，检查点指纹与181一致。

Harness原发行版不接受空闲maintenance的替换tool/result回放。早期手工补丁已停用，原始磁盘包恢复；当前正式适配见下节。原日志完整回放和7种错误替换负例通过；原会话277入库，相邻+5/−8/Δ1。91项定向与TypeScript通过；受控WSL完整5416项：5392通过/0失败/24跳过。仍不能声称未适配发行版、自动压力裁剪或全部外部E2E通过。

## 正式回放适配与治理实现

回放兼容从本机node_modules修改迁移为仓库管理的replay-compat.mjs启动适配器，经现有assets白名单与SHA256安装。专用dsh-agent-insight启动器在加载原生CLI前注册Node模块钩子；只接受0.2.2-rc.1已核对源码摘要，保持原始磁盘包和会话日志。未知版本/源码不应用兼容规则。兼容仍为集成适配，不能声称上游原版已修复。

正式outbox按端点/凭据scope限制64MiB、4096事件，死信8MiB/256事件，最长7天；用跨进程写锁检查配额，满额拒绝新事件并告警，不静默驱逐旧事件。400/404/413/422等永久失败隔离后继续发送；401/403暂停，429/5xx/网络错误指数退避并保留事件。所有重试状态持久化，关闭后重启不绕过nextAttemptAt。正文在活动队列和死信均按原expiresAt清除。

## 遗留锁恢复及压力验收补充设计

锁统一使用同主机/平台、PID和随机token的完整归属文件，以同目录临时文件加硬链接原子发布，避免半写锁。只在同主机/平台且PID被操作系统确认不存在时恢复；活动进程、EPERM、旧格式或未知主机保持busy。恢复使用独占recovery声明和原inode/token复核；普通获取者发布后复查恢复声明，避免并发抢占。恢复声明自身崩溃使用相同协议递归回收，最多8层；未知归属或更深嵌套fail closed，不能按年龄强夺。此边界独立测试并保留告警。共享模块同时供采集成员、outbox和平台正文使用，通过现有assets白名单/hash分发。

自动压力用独立headless真实会话和测试专用overlay：thresholdRatio=0.014、retainRatio=0.005，默认8192/4096/1024裁剪预算保持原样。没有手动调用pruneSession；以原生pre-step判压、原始prune事件、前后请求清单与正文核对为证据。这是早期低阈值结果；默认阈值补验见后续章节。


历史低阈值证据保留于实验报告；当前结果以下方默认压力和七天测试章节为准。正式安装器白名单仍仅0.2.2-rc.1与0.1.0-rc.8，后者只保证已测基础观测范围。

## 默认压力及真实七天测试设计

默认压力会话不覆盖compaction-basic配置，保留0.8/0.16和原裁剪预算；通过多份不同文件的真实工具读取累积到默认阈值，记录原生策略、模型窗口、触发位置及请求成员。未达阈值、人工触发或改变窗口不得记为默认通过。

真实保留样本从新的Harness任务正式入库，按原expiresAt运行7天，不修改系统时间或正文期限。独立采样器每小时检查授权API、文件存在/摘要和时间间隔，截止后验证410及常规cleanup删除。机器停机/服务不可用记缺口，不补造连续成功；到期前只记running。调度只运行本地测试，不设置聊天提醒或改变现有全局清理策略。

未知锁继续拒绝强夺，增加4096字节有界读取、UUID归属校验及只读状态分类；损坏、符号链接、无权限、外国/不同平台、旧格式或恢复深度过大不删除。追加负例和原样哈希验证。

## 本轮实测结果

默认0.8/0.16真实会话session-88186f7c-96c6-4ebb-be3c-aca66ad09573：模型窗口1048576、请求输出预留256000、headroom65536，实际预算为min(floor(window×0.8),window−maxTokens−headroom)=727040。原生估算875112触发72次自动prune，降至103498；#17/#454请求27/100成员、相邻+73/−0/Δ0，72个替换源指纹全部匹配后续成员，约束两请求可见。#307至#449事件均挂到#454。正文69可用/31截断，清单及指纹仍完整；不将截断内容冒充完整正文。新版本基本请求实测0.2.2-rc.4/0.2.1-rc.5均正式上报、成员绑定和授权正文200/no-store；但两者原生校验旧空闲裁剪日志均报tool/result is outside an open turn，因此不扩大安装器白名单或源码适配范围。

新增retention-soak.mjs为验收采样器，不随插件分发、不改变产品清理策略。真实样本session-d6abab71-51ac-4e87-ad61-3624970fb0ad从2026-11-18T09:04:41.601Z保留至2026-11-25T09:04:41.601Z，实际调度已执行。每小时及到期后5秒观察API、文件摘要/存在性、正文标记和no-store；清理宽限24小时，超过1.75采样间隔标缺口。Windows计划任务要求用户登录；断电、睡眠、服务停止和凭据不可用都不能补算连续成功。到期前状态为running，七天尚未完成。采样日志不保存正文或凭据，配置只保存凭据文件路径。

未知归属锁不按年龄删除；UUID token及4096字节有界读取、不跟随符号链接、inode校验已部署，inspectProcessLock只读分类。跨主机/平台、真实EACCES、损坏/超长、EPERM及深层恢复负例均保持原锁；仅同主机平台且ESRCH才可恢复。人工处置须先确认相关写入者均停止，备份原锁并核对归属；无法确认则保留busy，不能把诊断状态作为强制删除许可。

16文件107项定向、TypeScript通过；WSL全仓5432项，5408通过/0失败/24跳过。剩余为真实七天到期与物理清理结果、新增版本空闲裁剪回放、更多工具/Skill/子Agent组合兼容性、未知锁保守阻塞和父Trace即时物理级联擦除。原有压缩/模型切换证据沿用明确旧会话，不与本轮压力新会话混称一次运行。

## dsh-context 优先复用正式接入

当前主链路已从“仅同源token-meter”调整为“优先调用已安装dsh-context 0.85.1的结构化facts/delta，缺失时保留请求边界补采”。本轮真实Harness Web原会话7798f20f…的#292/#300/#311已正式入库投影。数据源从本机插件package.json确认版本；不是依赖本次无法注册的/version路由。模块不导入私有计算函数、不复制上游算法、不重新加载插件或改变提示词/压缩策略。

在同一Harness宿主中，用公开HostConnectionService.createPeer({principal:{kind:'owner'},interactions:'none'})及createSharedFetchHandler('/api')调用现有POST路由；这是安装于同宿主的受信任插件读取能力，不是新增网络鉴权旁路。Peer随插件释放，不保存浏览器令牌、不请求公网地址。远端用户仍必须走原有HTTP鉴权；不暴露此进程内能力为新平台路由。

| 接口 | 请求与复用字段 | 边界 |
| --- | --- | --- |
| POST /api/dsh-context/facts | sessionId、parts=['requests','events']、window requestsTail/eventsTail=256；value.rev/asOfSeq/parts.requests/events | 仅0.85.1结构；请求seq/turn/step唯一匹配；分类缺失不填零；事件窗口有限 |
| POST /api/dsh-context/delta | sessionId、seq、baseSeq；value.counts/removedCounts/tokenUp/tokenDown | 投影节点及Token差异，不是精确成员/正文差异；禁止上传viewNodes/viewHeader/text |
| POST /api/dsh-context/snapshot | 已确认的会话概览出口 | 本轮正式适配未调用，不声称用于请求成员历史 |
| OTLP补充事件 | agent-insight/context；无原生event.seq，body带responseEventSequence/turn/step/dshContext | 防止覆盖同seq原生LLM；平台按认证归属、源会话及响应轮步校验绑定，补充事件可乱序 |

categories保留system/tools/user/inject/skill/assistant/tool；UI映射为系统、工具定义、用户、运行上下文、Skill注入、历史回复、工具结果。每请求保存source、version、basis、revision、asOfSeq、approximate、total、eventsLimited和delta状态；只转发数值与受限事件kind/seq，不转发源正文。dsh-context估算与canonical补采估算口径不同；默认Token趋势优先投影，字节仍来自补采。投影Skill不是请求完整成员证明，dsh-context delta不能替代成员指纹对比。

核心遥测先持久化，再异步取可选投影；最多32个等待补充事件，源计算单在途、1.5秒超时，超时未完成的底层调用仍占在途槽，避免无限积累。缺插件、未启用成员、缺connection、未知版本、接口失败、请求不匹配、源忙等均明确状态，保留原Trace。可选投影在进程崩溃前尚未生成时可能丢失，不承诺自动补齐历史。

接入需安装并加载dsh-context 0.85.1及公开connection服务；本机Web已满足。成员采集仍显式启用AGENT_INSIGHT_DSH_REQUEST_MEMBERS=1；正文另需CAPTURE_BODIES/UPLOAD_BODIES独立同意。可用dsh plugin --profile web add dsh-context@0.85.1安装，再通过既有平台安装器安装采集器并重启Harness与平台消费者。安装器不静默安装第三方插件或开启正文。Headless未加载服务时显示回退，完整投影兼容未认证。

本轮17文件115项Linux定向、TypeScript通过；WSL全仓5440项，5416通过/0失败/24跳过。真实#292/#300分类13224/13271，delta新增assistant=1/tool=1、Token+34/+13；#311自动上报13351、baseSeq300。补采成员68/70/71独立存在。普通Tool及实际用量未被投影替换。后台旧消费者需重启，已捕获的前两补充记录重放后入库，最终续跑自动入库。前端SSR来源回归通过；浏览器热更新循环及控制超时使本轮人工页面验收未完成，不能写通过。

真实七天测试仍进行中，并已记录一次服务不可判定及采样缺口；原文件摘要未变，不能将缺口补算成功。原默认压力、压缩、裁剪、模型切换和正文治理证据继续有效但均按原口径标记；未重新用新适配完成所有事件的端到端人工复验。未提交/未合并/未发布、更多版本、安装向导及事件/对比UX评审仍待完成。


### 2026-11-19 acceptance update

2026年11月19日验收更新：页面人工功能验收通过；正式Headless配置通过；117项定向测试通过，TypeScript通过；全仓5442项，5418通过、0失败、24跳过，69 suites，216.577秒。七天实钟仍运行，15次采样、4次缺口、0次失败，到期为11月25日17:04:41.601。代码未提交、合并或发布。

Harness0.2.2-rc.1 / dsh-context0.85.1 / Node24.17.0的Web及Headless facts/delta已实测。Headless需在本profile安装插件，并加载原生credentials与connection服务；仅有插件而缺服务会回退。其他插件版本未认证；snapshot一次回调空集合，不能视为完整概览支持。

新页面人工功能验收已完成：#300分类趋势显示dsh-context0.85.1来源，选择后定位对应LLM，#300→#292前次请求导航及返回通过，投影delta与成员差异分开，配额缺失提示可见。浏览器错误日志为空。交互可用不等于事件与对比UX评审已完成。


## 目标行为的实现说明

### 目标行为的实现总览

本章把原始需求映射到当前代码和用户操作。总体链路为 Harness 原生会话与请求边界 → dsh-context facts/delta及成员正文补采 → 持久outbox → 现有认证OTLP → 平台聚合与正文私有存储 → Trace。两条数据支路按共享身份汇合，不以时间相近推断请求归属。

一期仅增强DeepSeek Harness。接入其他Agent时，Agent Insight的现有认证OTLP入口仍可使用，但对方需提供等价的请求身份、分类与来源契约，或实现专属适配；不是保持接口不变就自动获得完整上下文能力。不调整Agent提示词、模型或压缩策略，不自动归因或承诺改善任务成功率。

### 上下文趋势如何实现

数据来源：dsh-context-source.mjs调用facts，读取parts.requests每个模型请求的seq、turn、step、total及system/tools/user/inject/skill/assistant/tool七类估算。平台dshContextTokens将其映射为系统提示词、工具定义、用户消息、运行上下文、Skill注入、历史回复、工具结果。Skill投影不能作为完整Skill正文归属证明。

补充采集：index.js的buildRequestMembership从llm/stream参数生成成员清单，记录category、originalBytes、estimatedTokens等。该清单提供字节组成；没有可用dsh-context投影时才提供标明来源的Token估算回退。Skill目录等边界独有分类不应误认为dsh-context已单独计算的分类。

平台与页面：聚合结果保存于Session.interactions[].harnessRequests[]。HarnessContextPanel按sourceSessionId分组、按eventSequence排序，以请求为横轴绘制分类曲线和明细表，可切换字节与估算Token。缺失为null或横线，connectNulls=false，不连过缺失点；服务商input/output/cache实际用量独立列出，不与分类估算相加。

实现位置：scripts/agent-trace-collectors/deepseek-harness/dsh-context-source.mjs的normalizeContextFacts；src/lib/ingest/deepseek-harness-otel/context-membership.ts的dshContextTokens/summarizeHarnessContext；src/components/observe/HarnessContextPanel.tsx的HarnessContextPanel。

验收与限制：原真实会话#292/#300/#311已显示来源与分类；正式Headless #17/#25/#36投影均available。字节是采集字段字节，Token是估算，不代表服务商最终线上请求的精确Token。当前使用多条分类曲线及表格，不宣称已完成堆叠图或全部UX评审。

### 事件定位如何实现

双来源保留：原生OTLP收集compaction/start、compaction/end、compaction/summary、compaction/prune与model/selection；dsh-context facts额外提供compaction/prune/model等投影事件的seq/kind/tokens。二者保留各自来源，投影事件不改写原生事件身份。

发生位置：aggregator.ts按源会话累积原生事件，在后续模型响应请求建立harnessRequests引用时附上contextEvents，再清空该源待分配集合。因此事件标记表示发生在该次请求之前；事件自身eventSequence才是准确发生位置，不能把后续LLM的序号当作事件序号。末尾事件若没有后续模型请求，当前按钮链路不保证可独立呈现，属于覆盖边界。

页面行为：趋势区域提供“事件类型 #源序号 → #后续请求”按钮，点击定位对应LLM；请求详情展开事件白名单字段，如shadowedRange、shadowedSeqs、shadowedTokenCount、provider、model、reasoningEffort、status、outcome、sourceCommandId。dsh-context投影事件与eventsLimited则在结构化详情中展示。当前并非全部投影事件都有单独时间轴标注。

实现位置：src/lib/ingest/deepseek-harness-otel/aggregator.ts的contextEvents收集与请求绑定；dsh-context-source.mjs的区间事件筛选；HarnessContextPanel.tsx事件按钮；AgentTraceView.tsx事件详情。

验收与限制：已有原生压缩、自动压力裁剪、模型切换真实证据；本轮Headless可读取旧会话compaction#167、prune#222、model#192/#207源记录，但未在本轮Headless重新触发全部事件。facts的eventsTail=256，超窗或缺失时标记eventsLimited，不保证任意历史完整覆盖。

### 请求详情如何实现

请求成员清单：llm/stream进入时生成UUID attemptId，在请求边界读取系统项、工具定义及messages，记录itemId、position、category、sourceType、sourceEventSeq、可获取的sourceKind/sourceCallId、contentFingerprint、字节及bodyStatus。明确消息源事件时才填sourceEventSeq，否则为null，页面显示未提供、不推测。Skill消息仅按可识别来源分类，不能把任意工具文本自动判为Skill。

正文与平台分离：先脱敏，再按单条8KiB、每请求256KiB及每源会话1MiB等配额截断或省略。正文上传需独立开关；平台在现有OTLP处理链将正文分离到私有文件，Trace保存成员元数据与bodyRef。未开启、未上传、配额省略、截断及到期分别保留状态，不用重建正文填补原文。

用户操作：点击请求后选择对应LLM，在Harness请求标识内查看成员及正文。页面用GET /api/observe/session?taskId=<平台Trace>&view=context-body&sourceSessionId=<源会话>&contextRequestId=<bodyRef>按需取正文；服务端校验登录/API Key身份、Trace权限及请求归属，返回Cache-Control:no-store，到期410。HarnessBodyDetails逐项展示分类、来源、字节及可用text。

实现位置：index.js的buildRequestMembership/registerRequestMembers；src/app/api/observe/session/route.ts正文视图；scripts/agent-trace-collectors/deepseek-harness/index.js的本地正文持久化及src/lib/ingest/deepseek-harness-otel/body-store.ts等正文治理模块；AgentTraceView.tsx与HarnessContextPanel.tsx的HarnessBodyDetails。

验收与限制：正式Headless #17/#25/#36正文200/no-store，27/29/31成员均可见API约束。正文是脱敏采集边界记录，不是服务商最终请求报文；内容缺失不能证明约束被Agent删除。七天真实保留尚待到期验收，父Trace删除后的物理级联清除仍未实现。

### 相邻对比如何实现

第一层是dsh-context投影计算：调用delta({sessionId,seq,baseSeq})，保存addedCounts、removedCounts、tokenUp、tokenDown及baseSeq，表示分类投影节点与Token变化。它不是精确请求成员清单，更不是正文逐行差异。首请求为no-previous-request，缺失、超时或计算失败明确标记unavailable。

第二层是采集成员对比：平台仅比较同源会话、schema兼容且bindingStatus=bound的相邻清单，以稳定itemId判断新增与移除，以脱敏contentFingerprint及category判断变化。重复身份标ambiguous；不完整覆盖标partial，对无法确认的数量显示未知；记录缺口会重置前次成员，不跨缺失点伪造相邻比较。

页面行为：分别展示投影delta与成员+新增/−移除/Δ变化，展开各成员ID、分类和指纹。用户可跳到previousEventSequence查看移除前正文，再返回当前请求核对；现阶段没有自动逐行文本高亮或自动判断某条业务约束是否满足。截断正文不能支持全文一致性结论，脱敏指纹变化也不能反推出完整原文差异。

实现位置：dsh-context-source.mjs的delta调用；context-membership.ts的diffCapturedHarnessRequests/diffHarnessRequestMembership/harnessDiffLimitation；aggregator.ts的previousMembership；AgentTraceView.tsx的差异分组与前次导航。

验收与限制：#292→#300投影新增1助手/1工具，Token+34/+13，成员+2；#263→#277成员+5/−8/Δ1有历史实测。正式Headless后两请求delta available。比较对象必须标明来源，不能将上述不同会话和不同计算口径拼为同一次实验。

### Trace双向定位如何实现

共享身份分两阶段建立。请求前生成attemptId，并仅为经过原生Agent主循环身份检查的llm/stream采集候选；用请求signal关联源session与turn/step。收到原生响应后，仅在候选唯一且轮步一致时绑定response.eventSequence。内部摘要等非主请求或存在歧义的候选保留unbound，不按时间猜测。

正式遥测：原生事件及contextMembership先持久化到outbox并沿用POST /api/ingest/otel/v1/logs。可选dsh-context补充事件类型为agent-insight/context，不设置原生event.seq，body携带responseEventSequence/turn/step。这样不会因同序号幂等去重覆盖原LLM事件。

平台校验：按认证用户归属、sourceSessionId、responseEventSequence、turn、step关联投影与对应harnessRequests；schema、版本、来源和值域不合法的可选数据隔离。父子session使用各自sourceSessionId，避免相同seq串线。attemptId/bodyRef连接该次清单与正文，不能仅凭turn/step在不同源之间关联。

页面双向：AgentTraceView把请求引用与其所属LLM节点key放入entries；趋势或请求标识点击调用onJumpToKey；选中LLM后展示该节点的Harness引用，并以selectedKey高亮对应请求。一个节点若包含多个请求引用必须全部保留，不能假设所有场景天然一节点一请求。

实现位置：index.js的registerRequestMembers/registerLiveExporter；aggregator.ts的harnessRequests及projections绑定；context-membership.ts的validateDshContext；AgentTraceView.tsx的harnessRequests/selectedKey/onJumpToKey。

验收与限制：原会话#18/#27/#41/#59四条引用与左侧步骤可逐项对应；本轮页面#300→LLM与前次#292导航通过。正式Headless三请求已绑定清单、投影及正文。无成员或未知版本时原Trace继续工作，不能宣称旧历史可自动补齐。

### dsh context接口与职责边界

正式复用的是已加载插件公开Connection服务的进程内载体：HostConnectionService.createPeer({principal:{kind:owner},interactions:none})与createSharedFetchHandler(/api)。适配器构造POST /api/dsh-context/facts和POST /api/dsh-context/delta请求，由同宿主载体处理；这不是新开放一个绕过平台权限的公网接口，也不要求浏览器登录态或WebServer。外部网络访问仍沿用原认证。

facts入参为sessionId、parts=[requests,events]、window.requestsTail=256、window.eventsTail=256；成功体ok=true/value，读取rev/asOfSeq/parts.requests/parts.events。必须找到唯一匹配响应seq且turn/step一致的请求。delta入参为sessionId、seq、baseSeq；读取counts/removedCounts/tokenUp/tokenDown并转换保存。仅白名单数值与标识进入补充遥测，不转发viewNodes、viewHeader或正文。

版本与故障：当前正式实测Harness0.2.2-rc.1、Node24.17.0、dsh-context0.85.1，Web及Headless facts/delta通过。版本读取实际活动profile的已安装package.json，不借其他profile版本；Headless需官方安装插件并加载credentials与connection。未知版本、缺插件、缺服务、源忙和超时显式降级。snapshot概览未纳入正式采集，已知一次回调空集合；更多版本不能泛化为已支持。

性能隔离：核心遥测先入outbox，可选投影异步读取；最多32等待补充，源计算单在途，1.5秒超时，底层未结束仍占槽。可选投影失败不阻塞模型执行或原Trace；崩溃前尚未生成的投影不保证自动补齐。

覆盖结论：复用dsh-context完成分类估算、结构化事件及投影计算；Harness边界补齐请求成员、响应绑定、来源与脱敏正文；平台负责认证、持久化、配额、TTL与呈现。正文权限与留存不会因使用投影接口自动获得，需独立实现和验收。
