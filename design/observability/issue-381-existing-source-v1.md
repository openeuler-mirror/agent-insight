# Issue 381 第一版已有数据边界

本版仅使用修改前 Agent Insight 已接收的 Harness 遥测及 dsh-context 已维护的会话投影，不注册 agent/request 或 llm/stream 请求成员、正文采集。原有 SPAN 样式、右侧页签及独立滚动保持。

## 核查基准

Agent Insight 基准为当前仓库 HEAD 7f11dc5dd241ea082c8b7255fafab0528d81b34b，不代表已证明用户最早安装包与该提交完全一致。HEAD 的 otlp-json.ts 已读取 session.id 与 event.seq；原生 assistant/message 的 turn/step 用于 LLM 步骤聚合。HEAD 的 collector index.js 只做原生遥测脱敏，没有请求成员采集。

本机 Web 和 Headless profile 已安装 dsh-context 0.85.1。其 lib/index.js 包含 /api/dsh-context/facts 和 /api/dsh-context/delta，requestsTail、removedCounts、tokenUp/tokenDown 为现有结构。新增适配和投递已有投影是必要的接线工作，不能描述成修改前 OTLP 已自动包含 dsh-context 数据；不新增 Agent 请求采样，不修改提示词、模型或压缩策略。

## 逐项来源与处置

| 信息 | 来源字段 | 本版处置 |
| --- | --- | --- |
| SPAN、Tool、Skill、子会话、响应及用量 | 原有 Harness OTLP | 保留原 Trace；原输入历史不等于精确模型请求报文 |
| 请求关联 | session.id + event.seq + assistant/message turn/step；facts requests seq/turn/step | 全字段一致才关联；缺失不按时间猜测；序号是响应源事件引用 |
| 分类趋势 | facts parts.requests system/tools/user/inject/skill/assistant/tool/total | 只用有效投影，分类估算与 providerUsage 单列；缺失为空 |
| 相邻比较 | delta counts/removedCounts/tokenUp/tokenDown + baseSeq | 同源、相邻基准校验后展示节点数和估算 Token；不是成员或逐行正文差异 |
| 事件位置 | facts parts.events seq/kind/tokens | 只展示适配器保留的投影字段；定位同源请求区间，不宣称因果 |
| 模型切换 | 当前投影只有 kind=model，没有前后模型名 | 显示模型事件并标记切换未核实；不显示精确切换次数 |
| 摘要与裁剪条目 | 当前 facts 适配输出未包含正文或条目 | 明确缺失；移除高保真中未经此链路证明的正文、源条目和完成状态 |
| 成员、指纹及字节 | contextMembership 新增请求边界采集 | 移出本版展示；即使历史存在也不回退使用 |
| 精确正文差异与约束保留 | 需要逐请求正文归属 | 本版不提供，不能由 Token 减少或最终回答证明 |

## 当前真实会话复验

会话 session-7798f20f-5959-4533-89c9-2f42162a499c，2026-11-20 浏览器本地开发服务热刷新验证。#300 对比 #292 保留 dsh-context 差异（历史回复新增节点 1、估算 Token 增 34；工具结果新增节点 1、估算 Token 增 13）。#277 对比 #263 不再显示历史增强采集的 5/8/1，显示现有投影不可比较及数量未知。趋势只有 #292/#300/#311 有分类投影，其余保留缺失。事件来自投影：压缩 #167、模型事件 #192/#207、裁剪 #222；#167 展开仅 seq/kind/tokens=3661，摘要缺失。历史窗口不完整，不是整个会话发生次数。

## 代码及限制

展示入口为 HarnessContextTabs、HarnessContextPanel、HarnessAdjacentDiff；context-view.ts 仅接受校验后的投影事件与差异。collector apply 不再注册请求成员 hooks，既有环境成员开关不再激活该分支；dsh-context 读取与该开关解耦。保留历史实验工具、接口和测试供后续设计，不从当前看板挂入口；不删除历史正文存储或改变原有访问权限与 TTL。

本机已复制 collector 到 Web/Headless 共用安装目录，文件 SHA256 一致；已运行 Harness 进程须重启才能加载新代码，本轮未重启或触发新模型任务。旧队列可能仍有此前增强采集记录，页面不会将其作为本版依据。

七天保留属于历史增强正文实验，不作为本版无新增正文采集的验收前置；未到期及采样缺口不改写为通过。更多版本、精确正文、完整 UX 评审和正式发布仍未完成。

## 自动化测试记录

2026-11-20，以下六个测试文件共 57 项通过、0 失败：test/deepseek-harness-context-view.test.ts、test/deepseek-harness-adjacent-ui.test.ts、test/deepseek-harness-context-ui.test.ts、test/deepseek-harness-dsh-context.test.ts、test/deepseek-harness-plugin.test.ts、test/deepseek-harness-otel-ingest.test.ts。TypeScript 检查通过。

全仓 npm run test 汇总 5456 项，4840 通过、545 失败、71 跳过。存在 Windows fsync EPERM 等错误；benchmark-evaluator-api 工作进程失败后未退出，约六分钟后终止该工作进程才完成汇总，因此不是正常完整通过。定向测试包含在全仓集合中，不能累加。当前默认窄窗口的对比表有横向滚动和分类换行，完整可读性 UX 尚待优化。

## 既有细节接口复核更新

本节替代此前关于适配只保留 seq/kind/tokens、无模型名称及无节点片段的阶段性限制。已用未修改的本机 dsh-context 0.85.1 路由处理器，冷读同一真实 session-7798f20f-5959-4533-89c9-2f42162a499c 存量事件，未执行模型或采样请求。

facts events 返回 count/grossTokens/from/to/turn/step；detail 返回 nodes/archive；delta(seq,baseSeq=null) 返回 viewNodes/viewHeader/viewSystem。源码 Ce 对首个文本块压平空白并截到 80 字符，tool/result 不写入 text；系统只返回 Token 元数据，header 工具为名称、估算和 plugin，不含完整 description/schema。压缩摘要对应 compact-checkpoint 节点有源预览，但不是完整摘要。

实测：#192 deepseek-flash→deepseek-v4-pro，#207 反向变化；压缩 #167 后 #168 checkpoint 为 80 字符预览；存档中 41 个节点 gone=168。裁剪 #222 区间可见 #214 tool/bash gone=223，源正文未提供。count=42 与可见存档 41 不能强行认定完整覆盖。#300 viewNodes 34 项，其中 28 项有预览；detail 存档 42 项。没有将存档清单当作新增请求成员采集。

接入：dsh-context-details.mjs 规范化已有字段；context-membership.ts 校验并剥离文本；body-store.ts 将短预览存入已有侧存储，普通 OTLP spool/Trace 仅含元数据；原 context-body 接口在 Trace 权限与请求归属通过后读取。DshExistingDetails 展开已有预览；事件显示 from/to、候选 checkpoint 与归档替换点。导出最多 256 个节点、128 项工具元数据，正文每项最多源 80 字符，继承 8KiB/项、256KiB/请求、1MiB/会话、256MiB/4096 文件平台配额及七天上限；TTL 清理与队列到期去文本沿用既有机制。

已向本机平台回放七条既有投影，HTTP 200；浏览器验证模型名称、鉴权预览加载及裁剪正文缺失通过。并非新任务端到端，也未修改源 dsh-context 包。原本机开发服务发生 Turbopack panic，已用 Next 官方 webpack 开发模式恢复，非生产发布。剩余完整正文、摘要和精确裁剪成员覆盖仍不可由该接口保证。

本轮相关测试 60 项中 59 通过、0 失败、1 跳过（Windows 上的 Bash 执行用例）；TypeScript 通过。全仓复跑 5462 项中 4844 通过、547 失败、71 跳过；benchmark-evaluator-api 失败后挂起，终止该工作进程后才完成汇总。与前轮相比失败名称还涉及 benchmark 并发、onboarding 和 Dify 就绪探测，尚未归因。全仓未通过，不与相关测试累加。

补查 /fleet full=true：实际返回 initialPrompt（363 字符）、lastReply.text（47 字符）、4 条交流消息、delegations 和 truncated=false。该接口过滤为用户/Agent 交流视图，不包含逐请求完整上下文、developer checkpoint 正文或工具结果正文；原 Trace 已有同类交流信息，不再重复导出。/snapshot 为精简概况，也不能作为完整正文出口。contextHeaders 内部状态声明虽包含可选 system/schema，但上述对外视图会精简，未将内部私有状态当成稳定且已验收的数据契约。
# 2026-11-20 新任务在线端到端验收

会话 `session-af5e38da-e9a9-4e66-97fa-b5dcc7274c8d`，WSL 独立 Node.js 24、Harness 0.2.2-rc.1、dsh-context 0.85.1。只读任务使用 bash 输出 `ISSUE381_ONLINE_20261120_OK` 和工作目录，再用中文重申保持公开 API 不变。未修改 Agent 策略、插件源代码或模型配置；投影由在线 exporter 自动进入本机服务，没有回放或手工注入。

请求 #18 为 1/1，节点 #9、#10；请求 #26 为 1/2，节点 #9、#10、#18、#22。分类估算为前者 system=652/tools=4781/user=78/inject=147，后者新增 assistant=56/tool=23。相邻 delta 基准 #18，新增回复和工具结果各一项。主事件存储无节点 text，也无 contextMembership；片段 stored，鉴权加载成功。完整请求成员边界仍无法由投影证明。

对照高保真修复概览顺序：原有节点详情在前，上下文变化在后；补充窗口统计限制；修复整个会话事件空态误称“该区间”。保留原 SPAN、右侧独立滚动及页签保持。浏览器实测右侧 scrollHeight=1110/clientHeight=406/scrollTop=672，两侧底部均为 719；控制台 error 列表为空。

本轮无压缩、裁剪、模型切换，页面显示已采集范围未发现记录；不能沿用历史离线 #167/#192/#222 的证据宣布本轮事件在线通过。完整摘要、约束压缩后保留、完整正文差异、更多版本、七天实钟实验与正式发布仍未完成。

本机证据位于 `D:/Projects/Chat/Issue381-online-evidence.json`，断言脚本为 `verify-issue381-online.cjs`；新会话源事件路径列在该 JSON 中。页面截图使用 `Issue381-online-*.png`。本次 UI 回归断言原节点详情先于上下文变化，定向 60 项中 59 通过、1 跳过，TypeScript 检查通过。

本次全仓汇总 5461 项：4844 通过、546 失败、71 跳过；benchmark-evaluator-api 挂起后终止该测试 worker，其他失败尚未完全归因，未通过全仓验证。结果不可与前轮离线回放的 5462 项混用。更新后的统一 Word 为 `D:/Projects/Chat/Issue-381-Live-Acceptance-20261120.docx`，包含六张新会话在线截图及八条标准逐项状态。

## 同会话事件在线复验的更新结论

同一会话继续完成原生 UI 模型 Flash→Pro、`/compact`、长工具结果与恢复 Flash。dsh-context 投影事件 #40 为模型变化，区间 #26→#44；#50 为压缩，区间 #44→#62，10 条、gross 987、净变化 256，checkpoint #51 估算 731；#86 为模型恢复，区间 #70→#89。六条请求 #18/#26/#44/#62/#70/#89 全部自动在线导出，未回放或手工注入遥测。

当前默认 Web profile 未启用 toolResultPruner，无法声称默认 0.8 自动压力裁剪通过。限定测试会话的临时驱动调用安装包原始 ToolResultPruner 方法（未改默认 8192/4096/1024 字符预算、未挂服务、未改 profile 或策略），在维护锁内产生原生 #75 compaction/prune 与 #76 tool/result：原 #66 16041 字符变为 5159，首尾标记保留，删除 10882。#70 活跃 #66，#89 活跃 #76、归档 #66 gone=76；相邻投影工具 +1/-1、Token +1298/-4019。验收后重启未带 overlay 的原 Web 服务，临时驱动不再启用。

三类事件的“查看事件前/后上下文”均实际跳到上述请求并联动左侧 LLM；整个会话视图按相对 #44 的位置标注后续 #50/#75/#86。事件定位为同源相邻区间，不证明因果或最终请求报文成员。

修正前版限制：dsh-context 的 checkpoint 只有 80 字符预览，不等于原有遥测没有摘要正文。本条原生 compaction/summary.summary 为 2516 字符、checkpoint #51 为 2859 字符，两者包含保持公开 API 不变；当前看板只显示 80 字符开头且不含该约束。已有正文源的治理接入仍未完成，不应继续写成“两源无法提供全文”。最终线缆请求的精确成员仍不能由此证明。

发现未修复问题：工具 #63→首次结果 #66 为 174ms，裁剪替换 #76 距调用为 228128ms，现有 aggregator 的 tool/result 分支每次覆盖 completed_at，页面显示 3m48s。需区分真实执行完成与上下文替换，不能将事件展示通过升级为原有工具观测全部正确。

本次真实数据自动断言 11 组通过，定向测试 31 项全部通过；未改平台功能代码，未重复全仓。证据与驱动位于 `D:/Projects/Chat/Issue381-live-events-evidence.json`、`verify-issue381-live-events.cjs`、`issue381-native-prune-driver.mjs` 和同名 yml。统一 Word 更新为 `D:/Projects/Chat/Issue-381-Live-Events-Acceptance-20261120.docx`，包含本次八张截图；自动压力裁剪、正文全文页面、工具耗时、更多版本及七天实钟仍待完成。
