# 同步工具的 5 种典型失败模式

> **数据来源**：Shopify App Store 1-star 评论（Trunk、Syncio，2025-12 至 2026-10）+ inventory-doctor 诊断规则映射  
> **目的**：说明"为什么每个用了同步工具的商家都需要独立审计层"  
> **隐私**：所有案例已匿名化；SKU/店铺名/数量已修改；保留失败模式本身

---

## 为什么需要这份文档

同步工具（Trunk、Syncio、Synkro 等）解决的是"自动化库存同步"的问题，但它们**自己也会出错**。这不是质疑某个工具的质量，而是结构性的：

- 同步工具要**写库存**，写错了影响销售；
- 低概率、高影响的错误（如"5 年正常、突然崩溃"）在单个商家视角里几乎不可见，但在 App Store 的 3,000+ 评论里清晰可见；
- 同步工具无法自证"我们没写错"——它们既是运动员又是裁判。

**inventory-doctor 的定位**：独立、只读、可审计的对账层。下面 5 种失败模式都能在事故扩大前被检测到。

---

## 失败模式 1：库存被静默清零（nightly-zero）

### 商家自述

> "用了 5 年都很好，突然有一天所有缺货几个月的商品被标成有货，所有有货的被标成缺货。不得不手工盘点 3 万件商品。"  
> — Trunk 用户，2025-12

> "断开 Syncio 后，所有库存被清空，600+ SKU 全部被删除。"  
> — Syncio 用户，2026-05

### 根因分类

| 根因 | 症状 | 是否可逆 |
|---|---|---|
| **Blank CSV cell 被读成 0** | 导出时某列为空，导入器把空白当 0 | 部分可逆（如果有历史快照） |
| **同步配置错误** | "清空目标店后再同步"被误触发 | 不可逆 |
| **API 超时 / 部分成功** | 批量更新中断，已改的没回滚 | 部分可逆 |
| **时区 / 调度冲突** | 两个系统在同一时刻写，互相覆盖 | 不可逆 |

### inventory-doctor 如何检测

**规则：`nightly-zero`**

```bash
# 每天保存快照
inventory-doctor snapshot save shopify-store --name production

# 定期检查（如每天早上）
inventory-doctor snapshot check production --window 7
```

**触发条件**：
- SKU 在最近 N 个快照（默认 7 个）中**一直是正数**
- 最新快照突然变成 **0 或 null**
- 不包括"一直为 0"或"时好时坏"的 SKU

**输出示例**：

```
[CRITICAL] "TEE-BLK-M" was consistently positive across 6 snapshots 
           but reads 0 in the latest
  Evidence: 2026-10-28: 47 → 2026-10-29: 52 → ... → 2026-11-03: 0
  Risk: Classic "silently zeroed overnight" pattern; 
        if not a legitimate sellout, inventory was overwritten.
  Verify: Check overnight sync logs, CSV blank cells, and API call history
```

**为什么竞品做不到这个**：
- 同步工具只保留"最后一次同步日志"，看不到"历史上一直有货"
- 它们不会报告自己的写操作可能有问题

---

## 失败模式 2：空白单元格 vs 显式的 0（blank-vs-zero）

### 商家自述

> "导出的 CSV 里，未跟踪的变体数量列是空的。用 Stock Sync 导入后，所有未跟踪商品的库存变成了 0，触发了缺货通知。"  
> — 匿名，Reddit /r/shopify

### 语义差异

| CSV 内容 | Shopify 导入器行为 | Stock Sync 行为 | Matrixify 行为 |
|---|---|---|---|
| `Quantity` 列为**空白** | 忽略（不更新） | 转成 0（更新） | 取决于"空白策略"设置 |
| `Quantity` 列为 `0` | 更新为 0 | 更新为 0 | 更新为 0 |

**关键**：空白 ≠ 0，但大多数导入工具会把空白读成 0。

### inventory-doctor 如何检测

**规则：`blank-vs-zero`**

```bash
inventory-doctor diff store-export.csv supplier-feed.csv
```

**触发条件**：
- CSV 源中某个 SKU 的 quantity 单元格**物理上是空白**（不是字符串 `"0"`）
- 且**另一个源对同一个 SKU 有真实数量**

**输出示例**：

```
[CRITICAL] "MUG-WHT" has a BLANK quantity cell in supplier-feed.csv 
           at location "Warehouse B" (not "0") 
           while store-export.csv tracks a real quantity
  Evidence: supplier-feed.csv at location "Warehouse B": 
            quantity cell is blank, not an explicit zero.
  Risk: If the importer converts blanks to zero and applies inventory updates, 
        this cell could overwrite stock with zero.
  Suggestion: Check how the intended importer handles blanks (ignore, clear or zero); 
              enter a verified quantity only if an update is intended.
```

**为什么竞品做不到这个**：
- 同步工具在 API 层操作，看不到"CSV 空白单元格"
- 它们自己就是"把空白转成 0"的实施者

---

## 失败模式 3：重复 SKU 导致数量错乱（sku-mismatch）

### 商家自述

> "Syncio 创建了约 300 个重复产品，SKU 和原来的完全一样。库存分散在多个 variant 上，根本不知道真实库存是多少。"  
> — Syncio 用户，2026-03

> "同一个 SKU 在导出文件里出现了 3 次，数量分别是 10、5、0。导入后显示 0，前面两个被覆盖了。"  
> — 匿名

### 根因分类

| 根因 | 症状 |
|---|---|
| **产品被重复创建** | 同步工具判断"SKU 不存在"时创建新 variant，但其实已经存在 |
| **CSV 导出带重复行** | 多 location 导出时每个 location 一行，但导入器期望一行 |
| **手工编辑错误** | 复制粘贴时忘记改 SKU |

### inventory-doctor 如何检测

**规则：`sku-mismatch`**

```bash
inventory-doctor diff shopify-store.csv supplier-feed.csv
```

**触发条件**：
- 同一个源中，**同一个 SKU（归一化后）出现多次**，且数量不同
- 或：两个源中，SKU 只在一侧存在（孤儿 SKU）

**输出示例**：

```
[CRITICAL] SKU "TEE-BLK-M" appears 3 times in shopify-store.csv with different quantities
  Observed: shopify-store.csv rows 45, 67, 89 all have SKU "TEE-BLK-M"
            quantities: 10, 5, 0
  Risk: Import/sync behavior is undefined when one SKU maps to multiple quantities.
        The last row wins, or all rows sum, or the operation fails — 
        none are the intended stock level.
  Suggestion: Deduplicate "TEE-BLK-M" in shopify-store.csv: 
              one SKU should map to exactly one quantity per location.
```

**竞品能力对比**：
- ✅ Trunk Pro ($39)、syncX 免费档、Synkro、Sumtracker **都有重复 SKU 检测**
- ❌ 但它们检测的是"同步配置自检"，不是"跨源审计"
- ❌ inventory-doctor 额外检测：大小写变体、全角半角、零宽字符、前后缀配对

---

## 失败模式 4：多仓库存求和掩盖单仓缺货（location-orphan + oversell-risk）

### 业界已知问题

> "Trunk 的多 location 处理：先把所有仓库的库存**求和**，再同步到其他平台。结果是：A 仓 0 件、B 仓 50 件，显示'总库存 50'，但客户下单后发现 A 仓发不出货。"  
> — Sumtracker 竞品分析博客，2026-09

### 根因

- 多仓商家在 Shopify 里按 location 分别管理库存
- 同步到 Amazon/eBay 时，目标平台可能**不支持 location 维度**
- 同步工具选择"求和"或"取最大值"，导致**单仓缺货被掩盖**

### inventory-doctor 如何检测

**规则组合：`location-orphan` + `oversell-risk`**

```bash
inventory-doctor diff \
  shopify-location-a.csv \
  shopify-location-b.csv \
  amazon-fba.csv
```

**触发条件 A：location-orphan**
- SKU 在源 A 有 location "Warehouse A"
- 但源 B 对同一个 SKU **没有该 location 的行**

**触发条件 B：oversell-risk（逐 location 比较）**
- SKU 在源 A 的 location X 数量为 0
- 但源 B 的 location X（或求和后）显示 >0

**输出示例**：

```
[WARNING] "CAP-NVY" has location "FBA-US-EAST" in shopify-multi-location 
          but that location is absent from amazon-seller-central
  Risk: If both sources should stock this SKU at the same location, 
        inventory updates for that location may not reach the other source.
  Suggestion: Check whether the location was renamed, remapped, 
              deactivated or filtered out of one export.

[CRITICAL] "CAP-NVY" may oversell: 0 in shopify-multi-location at location "FBA-US-EAST"
           vs 24 in amazon-seller-central (aggregated or different location)
  Risk: Orders may be accepted when the intended fulfillment location has no stock.
```

**为什么竞品做不到这个**：
- 同步工具**自己就是求和的实施者**，不会报告"求和可能掩盖问题"
- inventory-doctor 默认**逐 (SKU, location) 比较**，不求和

---

## 失败模式 5：条码冲突导致串货（barcode-crosscheck）

### 商家自述

> "两个完全不同的产品，条码居然是一样的。Shopify 按条码匹配时把库存同步到了错误的商品上。"  
> — 匿名

### 根因分类

| 根因 | 场景 |
|---|---|
| **供应商复用条码** | 换季商品、测试品、赠品用同一个占位条码（如 `0000000000000`） |
| **手工录入错误** | 复制粘贴时条码没改 |
| **EAN/UPC 校验位错误** | 条码生成器算错，两个商品碰撞 |

### inventory-doctor 如何检测

**规则：`barcode-crosscheck`**

```bash
inventory-doctor diff store-a.csv store-b.csv
```

**触发条件**：
- 同一个 barcode 在**跨源**时映射到**不同的 SKU**
- 例如：源 A 的 barcode `123` → SKU `TEE-A`；源 B 的 barcode `123` → SKU `TEE-B`

**输出示例**：

```
[CRITICAL] Barcode 0000000000000 maps to 2 different SKUs across sources 
           ("GIFT-CARD" in store-a vs "SAMPLE-ITEM" in store-b)
  Observed: Barcode 0000000000000 is assigned to multiple distinct products.
  Risk: If barcode is used for matching during sync or import, 
        inventory may be applied to the wrong product.
  Suggestion: Verify product identity and barcode reuse first; 
              align SKU mappings or correct a barcode only after confirming 
              the intended identifiers.
```

**为什么竞品做不到这个**：
- 同步工具通常**信任条码**作为匹配键
- 它们不会质疑"同一个条码对应两个 SKU 是不是错的"

---

## 对比总结：inventory-doctor vs 同步工具内置检测

| 失败模式 | 同步工具能检测吗？ | inventory-doctor 如何更深？ |
|---|---|---|
| **库存被清零** | ❌ 只有"最后一次日志"，看不到历史趋势 | ✅ 快照时序分析（nightly-zero） |
| **空白 vs 0** | ❌ API 层看不到 CSV 空白单元格 | ✅ CSV-aware，区分物理空白 |
| **重复 SKU** | ⚠️ 部分有（Trunk Pro、syncX、Synkro） | ✅ 跨源审计 + 大小写/全角/零宽归一化 |
| **多仓求和** | ❌ 它们自己就是求和者 | ✅ 默认逐 (SKU, location) 比较 |
| **条码冲突** | ❌ 信任条码作为匹配键 | ✅ 跨源条码→SKU 映射校验 |

---

## 如何使用 inventory-doctor 避免这些失败

### 场景 1：每日定时审计（推荐）

```bash
# 每天早上 6 点（cron）
0 6 * * * cd /path/to/inventory && \
  inventory-doctor snapshot save production && \
  inventory-doctor snapshot check production --window 7 | \
  tee audit-$(date +\%Y-\%m-\%d).log
```

如果有 critical findings，发邮件或 webhook：

```bash
inventory-doctor snapshot check production --webhook https://hooks.slack.com/...
```

### 场景 2：导入前预检

```bash
# 导入供应商 feed 之前
inventory-doctor diff \
  current-shopify-export.csv \
  supplier-feed-2026-11.csv \
  --format terminal

# 如果 exit code = 1（有 critical），不导入
```

### 场景 3：多店同步后验证

```bash
# Trunk/Syncio 同步完成后
inventory-doctor diff \
  --store us-store \
  --store uk-store \
  --config inventory-doctor.json
```

### 场景 4：CI/PR 检查

```yaml
# .github/workflows/inventory-check.yml
name: Inventory Audit
on:
  schedule:
    - cron: '0 6 * * *'  # 每天早上 6 点
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: shidesheng0218/inventory-doctor-action@v1
        with:
          sources: |
            shopify-store-a.csv
            shopify-store-b.csv
          exit-on: critical
```

---

## 常见问题

### Q: 同步工具已经有"重复 SKU 检测"了，还需要 inventory-doctor 吗？

**A:** 需要。区别在于：
- 同步工具检测的是"自己的配置自检"（如 Synkro 检查"你配置的映射有没有冲突"）
- inventory-doctor 检测的是"跨厂商、跨数据源的独立审计"（如"Trunk 同步后，Shopify 和 Amazon 的库存对不对得上"）

同步工具无法自证"我们没写错"——它们既是运动员又是裁判。

### Q: 我的同步工具很稳定，5 年没出过事，还需要审计吗？

**A:** Trunk 用户的差评里就有"用了 5 年都很好，突然崩溃"的案例。低概率、高影响的错误是审计存在的理由——不是"每天都出事"，而是"出一次就是灾难"。

### Q: inventory-doctor 会自动修复吗？

**A:** 不会。它是**只读审计工具**，永远不写你的库存。发现问题后：
- 输出报告（terminal / JSON / Markdown / HTML）
- 可选：生成 review-only 的修正提案 CSV（`--fix-export`），需要人工审核后再导入
- 原则：**审计和执行必须分离**，这是可信的基础

### Q: 可以用 ChatGPT/Claude 对比两个 CSV 吗？

**A:** 对一次性、小规模场景（<100 SKU）可以。但：
- 通用 AI 不确定、不可复现、没有审计轨迹
- 大文件会超过 context 限制
- 无法进 CI、无法定时运行、无法给出确定性 exit code
- inventory-doctor 通过 MCP 可以**被 AI 调用**，而不是替代 AI

---

## 参考资料

- [Shopify App Store - Trunk 评论](https://apps.shopify.com/trunk/reviews)
- [Shopify App Store - Syncio 评论](https://apps.shopify.com/syncio/reviews)
- [Sumtracker 博客：Best Shopify Inventory Sync Tools](https://www.sumtracker.com/blog/best-shopify-inventory-sync-tools)
- inventory-doctor 规则文档：[README.md](../README.md)

---

**最后**：这份文档不是攻击任何同步工具，而是说明"同步"和"审计"是两个不同的职能。每个写库存的系统都需要一个不写库存的审计层——就像财务记账和审计必须分离一样。
