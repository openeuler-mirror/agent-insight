# Phase 3：开发计划

1. 修改 Prisma schema，增加 `caseCount`、`referenceCasesJson`、`projectionReady`。
2. 在数据集存储层增加投影构造、按用户回填、summary/reference 查询函数。
3. 修改创建、编辑、Trace 回流写路径，原子同步投影字段。
4. 扩展数据集 GET API 的 `summary/reference/full` 视图。
5. 将数据集卡片、Trace 回流目标选择器及仅需名称的选择器切换到 summary。
6. 将实验参考答案导入切换为 summary + 选中后 reference 按需加载。
7. 增加投影构造、历史回填、接口不泄露轨迹及写后同步测试。
8. 更新用户指南和开发者 API 契约。
9. 运行全量测试、TypeScript、ESLint、构建。
10. 在本机数据库副本验证迁移前后原表行数和 `casesJson` 校验值一致。
11. 备份 119 的数据库，在独立代码目录对 3000 共用数据库执行增量 schema，启动非 3000 端口并验证。
