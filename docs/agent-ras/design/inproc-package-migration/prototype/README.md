# Agent Insight 完整 UI 对照原型

静态 SPA：高保真复刻壳与侧栏主路由（假数据）。**环内 RAS 不在独立页**，只在 **链路追踪**列表/详情标识。

| 项 | 说明 |
|----|------|
| 打开 | `python3 -m http.server 8766` → http://127.0.0.1:8766/ |
| 版本 | **v3.3** |

## 产品对齐（v3.3）

- **无**侧栏「环内可靠性」、**无** `/ras` 路由  
- Trace 列表「环内 RAS」列 + 详情「环内检测」面板（假数据）  
- 后端设计：落库对齐 Insight ingest（`/api/ingest/ras/v1/events`、`witty.session.id`→`taskId`）；见结合方案 v1.6

## 文件

`index.html` · `styles.css` · `ui.js` · `pages.js` · `app.js` · `assets/brand/`  
（`ras.js` 已弃用，不再加载）
