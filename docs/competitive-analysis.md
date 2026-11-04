# inventory-doctor 竞品深度对比与优化方案

> **调研日期**：2026-11-04（实时抓取 Shopify App Store + 厂商官网）  
> **上次更新**：2026-09  
> **调研范围**：Shopify 生态 500+ 库存同步应用中的头部产品、数据源导入工具、全量库存管理平台

## 重要发现（2026-11 更新）

### 竞品功能快速商品化

相对 2026-09 调研，以下能力已从"差异化"变成"行业标配"：

- **重复 SKU 检测**：Trunk Pro、syncX 免费档、Easify、Sumtracker 都已内置
- **多 location 支持**：Syncio、Synkro、FlexSync、Sumtracker、Prediko 全部支持
- **Bundle 管理**：Trunk、Sumtracker、Prediko、Synkro（通过 Bundles.app）都有
- **MCP 出现**：Prediko 已推出 MCP server + AI agent "Pia"

### 核心定位不变

**所有竞品仍然是"同步引擎"（写操作），inventory-doctor 仍是唯一的"独立只读审计层"。** 功能差距在缩小，但结构性差异（只读、独立、本地、证据链）无法被同步厂商复制。

## 一、竞品格局与实时定价

### A. 实时同步引擎（直接相邻品类）

| 产品 | 定价（2026-11 实抓） | 评分 | 核心模式 | 新能力 vs 2026-09 | 弱点（用户评价） |
|---|---|---:|---|---|---|
| **Trunk** | $35 Essential / $39 Pro<br>按订单量升至 $45–119 | 4.9 (409) | 实时 15+ 渠道，SKU 匹配 | **Pro 含 duplicate SKU syncing** | 多 location 求和掩盖单仓缺货；低概率高影响错误（"5年用户崩溃，盘点3万件"） |
| **Syncio** | 免费 ≤25 产品<br>$19 / $29 / $39 | 4.7 (172) | Shopify + **WooCommerce**<br>多 location 可选 | **支持 WooCommerce、多 location、订单/payout** | "断开后库存被清零、600+ SKU 被删"；"创建300个重复产品"；"-1/-2库存" |
| **Synkro** | $10 / $25 / $50 / $100 | 5.0 (109) | 多店、集成 Bundles.app | **$25 档含 same-store location syncing** | 仍是写引擎；诊断深度有限 |
| **syncX Stock Sync** | 免费；$7 / $10 / $300 | 4.8 (936) | 60+ 连接，ISO 27001 | **免费档含 duplicate SKU sync** | Feed 工具，不是跨源审计 |
| **Tipo / QuickSync / Easify** | $9–29 起 | 4.6–4.8 | 多店、渠道、duplicate SKU / bundle | 低价竞争 | 长尾竞品 |

### B. 数据源导入工具

- **syncX Stock Sync**：$0–300/月，60+ 连接方式（Google Sheets/FTP/API），免费档已含 duplicate SKU 检测，ISO 27001 认证
- **Matrixify**：批量导入/导出，agency 常用（官网 520 错误，未抓到定价）
- **Syncee**：Dropship 市场，AI 选品/供货（与审计无关）

### C. 全量 IMS/ERP

- **Sumtracker**：$59 Manage / $119 Replenish 起，按年订单量分级；10 仓库/10 渠道；**bundle、duplicate listings、审计日志、12 个月历史、预测、PO**；Shopify 官方推荐
- **Prediko**：免费安装、收入制定价；AI 预测/补货/PO；**Prediko MCP + AI agent Pia**；4.9 (267)
- **Cin7 Core**：$349/月，完整 ERP

## 二、对比结论（2026-11 修订）

### 护城河评估

| 护城河 | 2026-09 判断 | 2026-11 修正 | 持久性 |
|---|---|---|---|
| 只读独立性 | 强 | **仍强** | 高：同步厂商无法自证"我们不写错" |
| blank-vs-zero | 强 | **仍强** | 高：竞品未强调 |
| 逐 location 审计 | 中强 | **减弱** | 中：多 location 已是标配，但"逐仓跨源审计+证据"仍稀缺 |
| 重复 SKU 检测 | 中强 | **明显减弱** | 低：已被免费化 |
| Bundle 组件 | 中强 | **减弱** | 中：Trunk/Sumtracker/Prediko 都有，但"组件反推可售性"仍独特 |
| MCP/agent | 中 | **减弱** | 中：Prediko MCP 已出现；MCP 标签不稀缺，规则深度才是壁垒 |
| 本地/隐私 | 强 | **仍强** | 高：竞品全云 |
| CI exit code | 强 | **仍强** | 高：竞品无 |
| 时序异常检测 | — | **新增强项**（已实现 snapshot + nightly-zero） | 中高：Sumtracker 有 12 月历史，但用于预测而非异常检测 |
| quantity-basis 语义 | — | **新增强项**（已实现 basis-mismatch warning） | 高：竞品不区分 available/on_hand/inventory |

### 竞争格局判断

**真正的竞争来自四个方向**：
1. **"什么都不做"**：商家觉得"现在没出事"
2. **同步引擎内置审计**：Synkro 已有重复 SKU 检测，Multi-Store Sync Power 已有 mismatch 检测
3. **Shopify 原生增强**：跨店报表、Flow、Dev MCP
4. **通用 AI + 表格**：对一次性、小规模场景"够用"

**inventory-doctor 的竞争问题不是"功能能不能打赢 Trunk"，而是"在同步引擎把审计变成免费功能之前，能不能先建立独立审计的品牌和分发"。**

## 三、优化方案（按 2026-11 优先级，已完成项标注 ✅）

### P0 — 修复边界正确性 ✅

1. ✅ **修复 `On hand (new)` vs `On hand (current)` 别名冲突**
2. ✅ **统一 product CSV inventoryPolicy 布尔归一化**
3. ✅ **增加 quantity-basis-mismatch 规则**
4. ✅ **降低 blank-vs-zero 噪声**（untracked + 无跨源冲突时降级）

### P1 — 深化护城河（已完成部分）

5. ✅ **增加 location-orphan 规则**（检测单侧存在的 location）
6. ✅ **快照历史与时序检测**（snapshot save/load + nightly-zero 规则，2026-09 已实现）
7. ⏳ **增强 bundle-availability**：支持嵌套、循环检测、组件缺失
8. ⏳ **增强 nightly-zero**：支持 location 级时序

### P2 — 扩大覆盖（试点验证后）

9. ✅ **WooCommerce adapter**（已实现；无多 location，见 README Honest limitations）
10. ⏳ **Amazon SP-API adapter**（最大缺口，但需明确试点需求）
11. ✅ **修复闭环：`--fix-export`**（2026-09 已实现，但定位为 review-only，不可直接导入）
12. ⏳ **Shopify OAuth flow**（`auth` 命令已有框架，需 Phase 3 hosted 版）
13. ✅ **规则配置化**（`inventory-doctor.json`，2026-09 已实现）

### P3 — 分发与体验

14. ✅ **HTML 报告**（`--format html`，2026-09 已实现）
15. ✅ **npm 发布**（`npm view` 显示 latest = 0.5.0）
16. ✅ **GitHub Action**（composite action，2026-09 已实现）
17. ✅ **MCP server**（6 个工具；`server.json` / Smithery / Glama 清单已就绪，注册表收录状态未核验）
18. ✅ **更新竞品文档**（本次更新）
19. ✅ **写"5 种典型失败模式"内容**：见 [sync-tool-failure-modes.md](sync-tool-failure-modes.md)

## 四、已过期/需修正的内容

### 过期声明（需删除或更新）

- ~~"竞品最多只有重复 SKU 检测"~~ → 已被多家免费化
- ~~"Syncio 是 Shopify↔Shopify 主从"~~ → 现已支持 WooCommerce + 多 location
- ~~"生成 Shopify 库存导入格式的修正 CSV"~~ → 当前定位是 review-only，与"只读"立场一致
- ~~"Bundle/kit 感知"列为 P3~~ → 2026-09 已实现 `bundle-availability` 规则

### 需补充的新发现

- Prediko MCP + AI agent "Pia"
- syncX 的 60+ 连接方式 + ISO 27001
- $0–$10 价格地板（syncX 免费、Synkro $10、Easify $9.99）
- Trunk/Syncio 的差评证据（库存被清零、重复产品、负库存）

## 参考来源

**2026-11-04 实时抓取**：
- Shopify App Store 页面（Trunk、Syncio、Synkro、syncX、Tipo、QuickSync、Easify、FlexSync、Prediko）
- 1-star 评论（Trunk、Syncio）
- 厂商官网（Sumtracker pricing、Prediko 首页、Syncee 首页）

**2026-09 历史来源**：
- [Sumtracker: Best Shopify Inventory Sync Tools 2026](https://www.sumtracker.com/blog/best-shopify-inventory-sync-tools)
- [Prediko: Top 9 Inventory Sync Shopify Apps 2026](https://www.prediko.io/blog/inventory-sync-shopify-apps)
- Shopify App Store 各竞品页面

---

**维护说明**：本文档应每季度复抓一次价格/评分/功能；竞品页面 URL 和抓取日期必须保留以便复现。
