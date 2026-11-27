# Docs Images

存放 `docs/README.md`、仓库根 `README.md` 以及其他仓库内 Markdown 文档引用的截图、架构图等位图资源。

- 推荐文件类型：`png`、`jpg`、`webp`、`svg`。
- 推荐命名：按页面或主题使用 kebab-case，例如 `skill-optimization-result.png`。
- 站点级品牌图标与可复用 Logo 不放这里，继续放在 `public/brand/`。
- Mintlify 站内文档若需要直接通过绝对路径访问的静态资源，优先放 `public/` 并用 `/...` 引用。

## 图片替代文本 / Image alternative text

信息性图片应使用描述性 alt，说明组件关系、操作点或图表结论，不能只写 `img`、图片编号或文件名。中文通常不超过 30 字，复杂图可放宽至约 50 字；英文文档使用英文。描述须结合实际图片和上下文人工核对，工具不会自动生成内容或判断描述是否准确。

Informative images need meaningful alternative text in the document's language. Describe the relationship, action, or result shown, rather than a filename or image number. Review the image and its context; the checker cannot verify factual accuracy.

提交前执行 `npm run docs:check-images`；使用 `npm run docs:check-images -- --json` 可输出逐图审计清单。检查覆盖 `docs/zh/` 和 `docs/en/` 中全部 Markdown/MDX 文档（包含 `docs/docs.json` 导航之外的文档），跳过 Markdown 代码示例。该检查也在默认单元测试及 PR 的 UT 门禁中执行。

Run `npm run docs:check-images` before submitting, or append `-- --json` for the image inventory. All Chinese and English Markdown/MDX documents are checked, including pages outside the navigation. The default unit tests and PR UT gate also run this check.

只有纯装饰性图片可保留显式空 alt。必须在 `docs/image-alt-decorative.json` 登记仓库相对路径 `file`、原始图片地址 `src` 和非空说明 `reason`，由审阅者确认；失效登记也会报错。缺失 HTML `alt` 属性不能通过装饰登记豁免。

Only decorative images may use an explicitly empty alt. Record their repository-relative `file`, original `src`, and a nonempty `reason` in `docs/image-alt-decorative.json` for review. Stale exceptions fail the check; a missing HTML `alt` attribute is never exempted.
