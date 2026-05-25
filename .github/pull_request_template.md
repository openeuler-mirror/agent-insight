<!-- PR 模板 · 任何修改了 UI 的 PR 都必须通过下面的双截图门 -->

## Summary

<!-- 1-3 句话说清楚改了什么、为什么改 -->

## Test Plan

<!-- 勾选 / 补充 -->

- [ ] 本地启动后路径 `...` 行为符合预期
- [ ] 关联的 unit / e2e 测试已添加或更新
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm lint` 通过

---

## 🌓 双主题截图门（UI 改动必填）

> **任何 PR 触碰了 `src/components/`、`src/app/`、`globals.css` 或会被用户看到的视觉/交互**——必须同时提供 **Light + Dark** 两张截图。
> 仅截亮色或仅截暗色的 PR **会被直接打回**（见 [`docs/design/foundations.md`](../docs/design/foundations.md) §1.2 第 5 条）。

### 截图

| | Light | Dark |
|---|---|---|
| 主路径截图 | <!-- 拖图或贴链接 --> | <!-- 拖图或贴链接 --> |
| 关键边缘态（空 / 错误 / 加载） | <!-- 拖图或贴链接 --> | <!-- 拖图或贴链接 --> |

### 对比度门

- [ ] 正文文字 vs 背景对比度 ≥ **4.5:1**（两套模式）
- [ ] 关键数值 / 标题 vs 背景 ≥ **7:1**（两套模式）
- [ ] 图表相邻系列对比度 ≥ **3:1**
- [ ] 状态色（success / warning / error）在两套模式下都能一眼区分

### 暗黑特殊核验

- [ ] 没有使用 `dark:` Tailwind 前缀（除非该值无法 token 化，并在 PR 说明）
- [ ] 没有在组件里使用 `bg-[#xxx]`、`text-[#xxx]`、`shadow-[...]` 等任意值色
- [ ] 所有 shadow / overlay / gradient 走 `var(--shadow-*)` / `var(--overlay-*)` Token，不直接写 `rgba(...)`
- [ ] 切换主题瞬间不闪烁（`next-themes` + `data-theme` script 已生效）

---

## 设计规范自查（UI 改动必填）

> 完整清单见 [`docs/design/components.md`](../docs/design/components.md) §6。这里只列必查项。

- [ ] 没有自己写 Button —— 用 `<Button variant="default|secondary|outline|ghost|destructive|link">`
- [ ] 没有自己写状态徽章 —— 用 `<StatusBadge>`
- [ ] 没有 `window.alert / window.confirm` —— 用 `sonner` toast 或 `<ConfirmDialog>`
- [ ] 没有 `mx-auto + max-w-*` 居中页面容器 —— 用 `<PageContainer>` 左对齐
- [ ] 列表筛选 / 分页 / Tab 状态写进 URL（用 `nuqs`）
- [ ] 长文本走 `<TruncateText>` / `<ExpandableText>`，不直接 `<p>{longString}</p>`
- [ ] 所有数值走 `<MetricValue>`（即使是"3 条"也走）

---

## Migration / Breaking Changes

<!-- 如果有破坏性改动、Schema 变更、需要手动迁移的步骤，写这里 -->

## Risks

<!-- 上线后可能影响的范围 / 监控指标 -->
