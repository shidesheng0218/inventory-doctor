# inventory-doctor 竞品深度对比与优化方案

> 调研日期：2026-09。调研范围：Shopify 生态 500+ 库存同步应用中的头部产品、数据源导入工具、全量库存管理平台。

## 一、竞品格局：它实际上没有"同类"

一个关键发现：**所有竞品都是"同步引擎"（写操作），而 inventory-doctor 是"诊断工具"（只读）**。这不是功能差距，而是品类差异。

### A. 实时同步引擎（直接相邻品类）

| 产品 | 定价 | 核心模式 | 弱点（用户评价佐证） |
|---|---|---|---|
| Trunk | $35/月起 | 实时多渠道同步，SKU 匹配，bundles | 多 location 时**求和后再同步**，掩盖单仓缺货；初始建库依赖"先连最准的店" |
| Syncio | $9–19/月 | Shopify↔Shopify，source/destination 主从 | 有评论报告**严重同步可靠性问题**；主从模型理解错了会搞乱库存 |
| Synkro | $10/店/月 | 可配置单向/双向，SKU/barcode 匹配 | **官方专门提供重复 SKU/barcode 检测工具**——承认这是高发事故源 |
| Multi-Store Sync Power | $19.99/月 | 多店实时双向，同步日志 | 有 SKU/barcode mismatch 检测（最接近诊断能力） |
| QuickSync | $19/月 | Shopify + Amazon/eBay/TikTok | 评论报告 TikTok Shop 渠道同步差异，"real-time ≠ error-proof" |
| Inventory Sync GoGo | $9.99/月 | 定时多渠道 | 用户抱怨"库存被随机改乱，要花数小时纠正" |

### B. 数据源导入工具

Stock Sync / SyncX（$7/月起，供应商 CSV/FTP/邮件 feed）、Matrixify（批量导入导出）、Syncee（dropship 向，$39.99/月）。

### C. 全量 IMS/ERP

Sumtracker（$59/月起，含采购/预测/补货，Shopify 官方推荐）、Prediko（$49/月，AI 补货）、Cin7 Core（$349/月）。

## 二、对比结论

### 差异化护城河（要加固，不要放弃）

1. **只读审计 vs 写操作同步** — 全部竞品都会改你的库存；用户最大抱怨恰恰是"同步工具自己把库存改乱了"。inventory-doctor 是唯一"不信任任何同步工具、独立对账"的审计层。杀手级定位：**每个同步工具的用户都需要一个独立审计工具**。
2. **本地优先 / 免费开源** — 竞品全部 SaaS 订阅（$7–349/月），数据上云；本项目零遥测、凭据不出本机。
3. **诊断深度** — blank-vs-zero 一等公民区分、按 (SKU, location) 逐仓对比（Trunk 直接求和）、大小写/零宽字符 SKU 归一化、健康分量化。竞品最多只有"重复 SKU 检测"，没有健康分体系。
4. **MCP 原生 + CI exit code** — 竞品无一是为 AI agent 设计的；无一带非零退出码进 CI。

### 真实短板（对照竞品能力矩阵）

1. **无时间维度** — 只做双快照对比。Synkro/Multi-Store Sync Power 有同步日志，行业最佳实践强调 Daily Reconciliation。这是最大短板。
2. **发现问题后无闭环** — 报告了 oversell 风险，但不产出"修正文件"，商家只能手工去改。
3. **数据源覆盖窄** — 只有 Shopify API + CSV；竞品普遍覆盖 Amazon/eBay/Etsy/WooCommerce API 和 FTP feed。
4. **无 OAuth** — client credentials 限同 org，agency 场景（竞品的付费主力人群）进不来。
5. **规则不可配置** — 阈值只能靠 CLI flag，无禁用规则/忽略 SKU 机制。
6. **分发缺失** — 未发布 npm、无 GitHub Action 模板。

## 三、优化方案（按优先级）

### P0 — 加固护城河

1. **快照历史与时间序列检测**
   - `inventory-doctor snapshot save <source>`：`InventoryRecord[]` 以 JSONL 追加到本地快照目录（无新依赖）
   - `diff --baseline <snapshot>`：与历史快照对比
   - 新规则 `nightly-zero`：检测"历史上一直有货、突然被归零"的 SKU
   - 复用现有架构：`loadSource` 增加 `{ kind: 'snapshot' }` 分支，core 内核不动
2. **修复闭环：`diff --fix-export fix.csv`** — 对 critical finding 生成 Shopify 库存导入格式的修正 CSV。保持"永不调写 API"原则，只生成文件由商家人工导入——可审计的修复本身就是卖点。

### P1 — 扩大覆盖

3. 新 adapter：WooCommerce REST API、Amazon SP-API（架构已支持"加一个 adapter 不用重构"）
4. Shopify OAuth flow：`inventory-doctor auth <domain>` 本地回调拿 token，解开 agency 场景
5. 规则配置化：`inventory-doctor.json` 增加 `rules` 字段（阈值、disable、ignoreSkus），CLI flag 保持覆盖优先级

### P2 — 体验与分发

6. HTML 报告（`--format html`，单文件无依赖，健康分可视化）
7. npm 发布 + `npx inventory-doctor` 零安装路径 + GitHub Action 模板
8. README 定位段落（见本文档）

### P3 — 远期

9. Bundle/kit 感知（检测"组件缺货导致 bundle 不可售"）
10. 定时守护 + webhook 通知

## 参考来源

- [Sumtracker: Best Shopify Inventory Sync Tools 2026](https://www.sumtracker.com/blog/best-shopify-inventory-sync-tools) — 10 款工具实测评分、Trunk 多仓求和细节、Synkro 重复 SKU 检测
- [Prediko: Top 9 Inventory Sync Shopify Apps 2026](https://www.prediko.io/blog/inventory-sync-shopify-apps) — 定价矩阵、用户差评摘录
- [Syncio - Shopify App Store](https://apps.shopify.com/syncio)
