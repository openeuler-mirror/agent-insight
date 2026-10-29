# 多版本资产与多轮对话评测：需求设计

日期：2026-10-29。状态：已按确认的主线复用方案设计，开发中。

## 1. 结构

原业务表继续代表已发布当前内容。新增共享版本库记录三类资产，新增独立草稿支持数据集逐 Case 编辑。实验仍由原 `Experiment` / `ExperimentCase` / `ExperimentTraceAttempt` / `ExperimentEvalResult` 承载，不新增一套实验运行表。

版本模块放在 `src/lib/evaluation-assets/`；多轮定义与证据放在 `src/lib/engine/experiment/` 的独立模块。演示代码只按算法提取，不复制 Demo catalog、profile、凭证或菜单开关。

## 2. 版本数据模型

| 模型 | 关键字段 | 不变量 |
|---|---|---|
| EvaluationAssetHead | id, user, kind, businessId, publishedVersion, revision, archived, createdAt, updatedAt | unique(user,kind,businessId)，kind 为 agent/dataset/evaluator |
| EvaluationAssetVersion | id, assetId, version, contentJson, contentHash, note, source, createdAt | unique(assetId,version)，只追加；保留历史，不级联删除 |
| EvaluationAssetDraft | assetId, baseVersion, revision, contentJson, updatedAt | 每本体一份草稿，CAS 防覆盖；首版用于 dataset |

Agent businessId 编码平台和 canonical Agent 名称，不含客户端/IP/模型；RegisteredAgent 只作可选来源。数据集使用原 id；评估器使用原稳定 id。

发布流程在 SQLite 事务中：校验权限和源对象 → 初始化旧内容首版（必要时）→ 比较语义指纹 → CAS 更新 Head 计数 → 插入不可变版本 → 更新原业务已发布投影 → 删除对应草稿。唯一冲突/数据库锁按有界策略重试；不是裸 max+1。相同语义内容复用当前版本。

语义指纹包含业务定义、字段、Case 顺序与逐轮规则；排除更新时间、运行状态、生成进度及派生 rootCauses/rootCauseMeta 缓存。版本库只存定义和非敏感模型引用，不存真实密钥。

草稿发布要求 baseVersion 等于当前 publishedVersion 且 revision 匹配。若旧 API/后台发布过新内容则返回 409，保留草稿供用户查看，禁止静默覆盖。单 Case 修改以 Case ID 定点合并完整草稿，并以 revision CAS 更新；保存/回退不改已发布主表。

## 3. 旧写路径兼容

- 普通数据集 create/update、回流与 Skill 工作台：在现有 storage helper 中以事务同时写当前投影和版本。变更前先保存旧版，避免把已有内容误称为从未存在。
- Trace 生成 manager 的占位、进度和失败不发布版本；worker 成功提交内容时在既有事务内记录版本。Benchmark 受控导入/更新亦使用同一事务服务，保留系统所有者与不可编辑约束。
- 自建评估器整列表 PUT 仍校验、规范化 Skills、更新注册和缓存。根据稳定 ID 比较规范化内容，仅变化的项增版，删除的项归档，不能丢失未修改项或旧版本。
- 如果发现历史直接写库导致投影与版本头不同，版本读取/选择时可同步当前已完成内容，按内容去重；不能凭现值虚构未保存的中间历史。
- OpenGauss 保留原读写路径。新增版本接口对不具备原子版本存储的后端返回明确的能力不支持；不把 SQLite 侧库写入伪装成 OpenGauss 原子发布。

## 4. API 增量

使用独立 `/api/evaluation-assets` 入口与相应资产子路由，旧 API 合同保留。具体 method/action 可随实现收敛，但需满足以下语义：

| 操作 | 输入 | 输出/失败 |
|---|---|---|
| 列出资产版本 | kind, businessId | 本体、当前发布版及版本摘要，内容按需读取 |
| 读取版本 | versionId | 用户域内完整定义及内容指纹 |
| 登记 Agent 版本 | platform, agentName, note, 定义元数据 | 新版本/去重复用版本；不能绑定错误平台 |
| 发布评估器 | 稳定 evaluatorId、已规范化定义、基线版本 | 固定定义及原列表投影；保存 Skills 仍走原校验 |
| 读取/创建数据集草稿 | datasetId, baseVersion | draft、revision |
| 保存/回退一个 Case | caseId, case/revert, revision | 更新的 draft/revision；冲突 409 |
| 发布数据集草稿 | baseVersion, revision, note | 原子生成新版本并更新主表 |

新接口调用 `resolveUser(request)`，不传可信用户名旁路；从真实 Key 得到 actor 后检查 Head 与源对象权限。公共 Benchmark 只读；禁止用 body/query.user 冒充其他人。客户端通过原 auth context 附加现有 Key，不新建登录流程。

## 5. 实验版本冻结

`configSnapshotJson.assetVersions` 保存 schemaVersion 及 agent/dataset/evaluators 引用（业务 ID、版本 ID、版本号、hash、必要的冻结定义）。评估器 ID 列表保持不变，选定版本的卡片填入原 `customEvaluatorSnapshots`，Skill 快照继续按原 snapshotHash 校验。

新字段可选。旧请求不带版本时仍使用当前已发布内容并在可确定时记录版本；不能因上线强迫旧调用方更换请求体。带版本时核对业务身份与内容，不信任客户端提交的版本 JSON。复测沿用冻结引用与定义，明确切换版本才重新解析。

Agent 版本控件放在原执行目标选择之后，按具体 platform/agent 激活；不改变原聚合 Agent 列表。已有 Trace 评测按可确定的平台绑定版本；不能推断的历史记录显示未确认，不强行标成某个已加载版本。

## 6. 多轮 Case 与规则

`DatasetCase` 增加可选 turns；旧无 turns 数据按单轮理解，不强制改写。逐轮包含 id、input、expectedOutput、expectation；expectation 支持 contains/pattern、expectedSkill/state、requiredTools(name,arguments)、forbiddenTools、toolOrder、JSON fields、blocking。

输入长度、轮数、工具数量、字段数量有统一服务端上限，正则在受限执行环境内判断。必须工具与禁止工具冲突在保存时拒绝。顶层 input 来自首轮，expectedOutput 来自末轮；多轮规则详细配置放在单 Case 对话框，主表仍是一行。

## 7. 原生多轮执行合同

`RUN_EXPERIMENT_CASE` 增加可选 conversation 合同（version、turns[id,input]）。预期答案、评分点、工具规则不下发给待测 Agent。客户端上报明确的 multiTurn/sessionContinuation 能力；服务端和向导同时校验能力，旧客户端仍接受旧单轮请求。

一次 Case/Attempt 创建一个新 session/workspace；客户端在该工作区中循环 OpenCode v2 `run --session <same-id>`。每轮复用 session，整个 Case 重试才新建 session。轮间检查取消，沿用原执行槽、进程组终止、持久运行状态及 Attempt fence，不另做一套队列。

命令结果包含完成轮数、输入轮次/最终消息锚点等可核对的完成证据。服务端必须等 Trace 中相应最终轮事实可见后绑定最终输出，不能因第一轮 Session 暂时结束就提前成功。原 Trace ID 复用检测、晚到结果、取消后不回写等合同不变。

Pi 当前 collector 使用 `session__taskN`，xiaoO 尚无可确认续接合同；首版不改变它们的单轮采集，也不宣称支持多轮下发。

## 8. Trace 回放、评测与详情

复用原 Session interactions，按用户轮次和工具调用 ID 建立证据。保持 system/assistant/tool 的边界及原始消息定位。缺失工具集合是未采集，空集合表示确认未调用；缺少该轮回复为未评完整。

内置“逐轮业务规则”归类为轨迹评测，经原注册表和实验 runner 执行，输出原评分点结构；每点含 turn、判定、得分、证据锚点和规则生成的建议。原结果评估器按完整对话/最终输出工作，人工分、缺分与失败聚合口径沿用主线。

详情复用现有结果/轨迹分栏。Case 列表一条逻辑 Case 一行，已有 A/B 按稳定 Case 身份配对，分页不拆两侧；新增/删除/规则变化明确标记。版本记录与趋势复用现有版本工作区，原 Trace 标签分析保留，实验按执行条件分组并显示条件。

## 9. 测试和可交付证据

基线先使用独立 SQLite 数据根运行，不把旧演示数据库或旧失败统计当成当前基线。专项测试覆盖版本并发/去重、草稿CAS、旧写兼容、越权、冻结与复测、逐轮规则、会话与Attempt隔离、取消、末轮Trace晚到。

真实验收使用明确的测试账号、测试数据集和本机/测试执行客户端：旧单轮、三轮随机信息任务、跨Case隔离、三类对象v1/v2、冻结旧版运行、旧数据升级及空库。协议fixture、真实CLI、本地模型/远端真实模型、浏览器分别标证据，不互相替代。真实连接密钥仅在运行环境读取，不能进入文档、Trace人为注入字段或提交。
