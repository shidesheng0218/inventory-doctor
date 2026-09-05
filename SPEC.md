# Inventory Doctor — 技术实施方案

## 项目概述

**项目名**:`inventory-doctor`
**一句话定位**:多平台库存同步诊断工具——找出你正在超卖但还不知道的 SKU。
**形态**:单一 npm 包,提供 CLI(`inventory-doctor diff`)和 MCP server(`inventory-doctor mcp`)两个入口,共享同一套纯函数诊断内核。
**技术栈**:TypeScript(ESM)、Node ≥ 22(pnpm 11.x 要求 Node ≥ 22.13,故实施时把最低版本从最初计划的 20 上调)。
**数据源**:CSV/Excel 导出文件(零凭据)+ Shopify Admin API(可选,自动拉取)。

**核心设计原则(必须遵守)**:
所有诊断逻辑写成**纯函数**,输入是规范化后的中间表示 `InventoryRecord[]`。CSV parser 和 Shopify API client 都只是产出这个中间表示的 adapter。CLI 层和 MCP 层只做入参解析与输出格式化,不含业务逻辑。这样新增数据源(Amazon/Woo/BigCommerce)零重构。

---

## ⚠️ 已验证的技术事实(实现者必读,违反会直接报错)

以下每一条都经过 2026-09 实际核实,**不要按旧教程或训练数据里的印象写**:

### Shopify GraphQL Admin API
1. **最新稳定版本是 `2026-07`**。请求 URL:`https://{shop}.myshopify.com/admin/api/2026-07/graphql.json`。版本号必须显式写在 URL 里。响应头 `X-Shopify-API-Version` 若与请求不一致,说明被 fallback 了。
2. **`InventoryLevel.available` 字段已被彻底移除**(不是 deprecated,是不存在)。唯一读法是 `quantities(names: [String!]!)`,且 `names` **无默认值必须显式传**。合法值:`available`、`on_hand`、`incoming`、`committed`、`reserved`、`damaged`、`safety_stock`、`quality_control`。
3. **`InventoryItem.variant`(单数)已 deprecated**,用 `variants`(复数,是 Connection)。
4. `ProductVariant.inventoryQuantity` 仍可用,等于总可售量。**但不要用 `sellableOnlineQuantity` 做对账基准**——它只算线上渠道。
5. `inventoryLevels` 默认 `includeInactive: false`,要全量位置需显式传 `true`。
6. **只读所需 scopes 恰好三个**:`read_inventory`、`read_products`、`read_locations`。不要申请任何 `write_*`。`read_product_listings` 不是 Admin scope,不要写。
7. **分页**:cursor-based,单页最大 250,用 `pageInfo { hasNextPage endCursor }`。cursor 是不透明串,禁止自造。
8. **速率限制**:leaky bucket 按点数计。**不要硬编码任何 plan 的速率数值**(官方从未公布 bucket size,文档里的示例值与任何档位都不吻合)。正确做法是每次响应读 `extensions.cost.throttleStatus.currentlyAvailable` 做自适应节流,被限流后退避 1 秒。响应结构:
   ```json
   "extensions": { "cost": {
     "requestedQueryCost": 101, "actualQueryCost": 46,
     "throttleStatus": { "maximumAvailable": 1000, "currentlyAvailable": 954, "restoreRate": 50 }
   }}
   ```
   限流按 **app + store 组合**独立计,所以多店铺可以并发,互不挤占额度。

### Shopify 凭据(重要:路径在 2026-01-01 变了)
9. 后台 `Settings > Apps > Develop apps` 拿永久 token 的老路径**已无法新建**(2026-01-01 起)。已存在的 `shpat_` token 继续可用。
10. **新用户走 client credentials grant,不需要 OAuth 回调服务器**——这是本项目采用的方案:
    ```
    POST https://{shop}.myshopify.com/admin/oauth/access_token
    Content-Type: application/x-www-form-urlencoded
    grant_type=client_credentials&client_id={id}&client_secret={secret}
    → { "access_token": "...", "scope": "...", "expires_in": 86399 }
    ```
    注意:endpoint 在**店铺域名**下不是 Shopify 中心域;请求**不要传 scope**;token 有效期 24h,必须缓存并提前 60s 刷新,不要每次调用都换。
11. **client credentials 的限制**:app 与 store 必须在同一 org。对"商家给自己店做工具"这个主场景成立;代理商服务客户店铺会报 `shop_not_permitted`,那种情况只能走完整 OAuth(**本项目第一版不实现 OAuth**,只在文档里说明限制)。
12. 因此**凭据层必须做双模式**:静态 `shpat_` token(存量用户)+ client credentials 动态换取(新用户)。抽一个 `TokenProvider` 接口把两者收敛。

### Shopify CSV 导出(列名和你记忆里的不一样)
13. **当前商品 CSV 导出的表头已改名**,但导入仍兼容旧名,所以**两套表头都会在真实文件里遇到,parser 必须同时接受并做别名映射**:

| 旧列名(仍用于导入) | 当前导出实际列名 |
|---|---|
| `Handle` | `URL handle` |
| `Variant SKU` | `SKU` |
| `Variant Inventory Qty` | `Inventory quantity` |
| `Variant Barcode` | `Barcode` |

14. **商品 CSV 不含分位置库存**(`Inventory quantity` 仅对单一位置的店铺有意义)。多位置必须用专门的库存 CSV(`Products > Inventory > Export`)。
15. **库存 CSV 有两种格式,工具必须自动识别**:
    - **长表(All states,推荐)**:一行 = 变体 × 位置。列含 `Handle`、`Title`、`Option 1 Name`/`Value`、`SKU`、`Location`、`Bin name`、`Incoming (not editable)`、`Unavailable (not editable)`、`Committed (not editable)`、`Available (not editable)`、`On hand (current)`、`On hand (new)`
    - **宽表(Available)**:**位置名直接作为列头**,下方是数量。只能靠"非已知列 = 位置列"来推断。
    - 注意:表头带 `(not editable)` / `(current)` 后缀必须原样匹配或做后缀剥离;`Location` 值区分大小写。

### Amazon 及其他平台
16. **Amazon 报告的确切表头无法确认**(官方文档失效,且表头随 marketplace 和 Custom 选项变化)。已确认:报告是 **tab 分隔**(扩展名常为 `.txt`)。社区常见字段 `seller-sku`、`asin1`、`quantity`、`fulfillment-channel` 但不保证完整。
17. **因此不要硬编码任何平台的表头**。做**列名探测 + 别名字典 + 可配置/交互式列映射**。这不是妥协——它顺带让工具支持 Woo/BigCommerce/任意 ERP 导出,是更强的产品能力。

### MCP TypeScript SDK(选定 v1)
18. **包名 `@modelcontextprotocol/sdk`,版本 `1.30.0`**。注意 npm 上还存在一个 `@modelcontextprotocol/server` 2.0.0(v2 拆包版),**本项目不用它**,不要混用两者的 API。
19. v1 的正确写法:
    ```ts
    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { z } from 'zod';

    const server = new McpServer({ name: 'inventory-doctor', version: '0.1.0' });
    server.tool(
      'diff_inventory',
      'Compare inventory across two sources and report sync problems',
      { sourceA: z.string().describe('Path to first CSV'), sourceB: z.string().describe('Path to second CSV') },
      async ({ sourceA, sourceB }) => ({
        content: [{ type: 'text', text: JSON.stringify(await runDiff(sourceA, sourceB)) }],
      }),
    );
    const transport = new StdioServerTransport();
    await server.connect(transport);
    ```
    v1 的 `server.tool()` 签名是 `(name, description, zodShape, handler)`,**zodShape 是裸对象不是 `z.object(...)`**。
20. zod 版本:v1 接受 `^3.25 || ^4.0`。
21. **三个致命坑**:(a) **stdout 是 JSON-RPC 协议通道,一次 `console.log` 就破坏协议**,所有日志必须走 `console.error`;(b) 必须是 ESM(`"type": "module"`);(c) MCP server 进程内不要有任何库往 stdout 写东西。
22. `.mcp.json` 配置格式:
    ```json
    {
      "mcpServers": {
        "inventory-doctor": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "inventory-doctor", "mcp"],
          "env": { "SHOPIFY_CLIENT_SECRET": "${SHOPIFY_CLIENT_SECRET}" }
        }
      }
    }
    ```
    `env` 支持 `${VAR}` 展开,凭据用这个引用,不要硬编码进仓库。

### 未确认项(实现时需实测或规避)
- Shopify 是否接受 `http://127.0.0.1` 作 redirect URI(本项目不走 OAuth,暂不影响)
- 各 plan 的 bucket size(已用运行时读 `throttleStatus` 规避)
- 2026 Dev Dashboard 迁移后 development store 的免费额度与数量上限(旧文档称免费无限,新文档未重申)
- Amazon 报告完整表头(已用列名探测规避)

---

## 架构与目录结构

```
inventory-doctor/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── core/                      # 纯函数诊断内核,零 I/O、零依赖平台
│   │   ├── types.ts               # InventoryRecord 等中间表示
│   │   ├── normalize.ts           # SKU 规范化(大小写/空格/前后缀)
│   │   ├── diagnose.ts            # 诊断规则总入口
│   │   └── rules/                 # 每条诊断规则一个文件
│   │       ├── sku-mismatch.ts
│   │       ├── quantity-drift.ts
│   │       ├── blank-vs-zero.ts
│   │       ├── barcode-crosscheck.ts
│   │       ├── oversell-risk.ts
│   │       └── untracked.ts
│   ├── adapters/                  # 数据源 → InventoryRecord[]
│   │   ├── csv/
│   │   │   ├── detect.ts          # 格式与列名探测
│   │   │   ├── aliases.ts         # 列名别名字典
│   │   │   ├── shopify-product.ts
│   │   │   ├── shopify-inventory.ts  # 长表/宽表双格式
│   │   │   └── generic.ts         # 任意 CSV + 列映射配置
│   │   └── shopify-api/
│   │       ├── token-provider.ts  # 双模式凭据 + 24h 缓存
│   │       ├── client.ts          # GraphQL client + 自适应节流
│   │       └── fetch-inventory.ts # 分页拉取 → InventoryRecord[]
│   ├── report/
│   │   ├── terminal.ts            # CLI 表格输出
│   │   ├── json.ts                # 机器可读(MCP 用)
│   │   └── markdown.ts            # 可粘贴的报告
│   ├── config.ts                  # 配置文件读取与校验
│   ├── cli.ts                     # CLI 入口
│   └── mcp.ts                     # MCP server 入口
├── fixtures/                      # 脱敏样例 CSV(README 演示用,很重要)
│   ├── shopify-store-a.csv
│   ├── shopify-store-b.csv
│   └── expected-report.md
└── test/
    └── core/                      # 诊断规则的单元测试
```

### 核心中间表示(所有 adapter 都产出这个)

```ts
// src/core/types.ts
export interface InventoryRecord {
  source: string;           // 数据源标识,如 "store-a" / "amazon-export"
  sku: string | null;       // 原始 SKU(未规范化)
  barcode: string | null;   // 用于交叉校验
  title: string | null;
  location: string | null;  // null = 该数据源无位置维度
  quantity: number | null;  // null ≠ 0,这个区分是核心诊断能力
  quantityRaw: string;      // 原始单元格内容,用于判断空 vs "0"
  tracked: boolean | null;  // Shopify 的 inventory tracker 是否开启
  meta: Record<string, string>;  // 保留其他列,便于扩展
}

export interface Finding {
  rule: string;
  severity: 'critical' | 'warning' | 'info';
  sku: string | null;
  message: string;
  detail: Record<string, unknown>;
  suggestion: string;       // 商家该怎么办
}
```

**关键点:`quantity: null` 与 `quantity: 0` 必须严格区分**——CSV 空单元格被当成 0 是真实事故来源之一,这是本工具的核心诊断价值。

---

## 诊断规则(第一版六条,按价值排序)

每条规则是 `(records: InventoryRecord[]) => Finding[]` 的纯函数。

### R1. `sku-mismatch` — 跨源 SKU 映射诊断(最高价值)
检测两个数据源之间对不上的 SKU,并区分失配类型:
- **仅大小写差异**(`ABC-123` vs `abc-123`)→ warning,给出规范化建议
- **仅首尾空格/不可见字符差异**(含全角空格、零宽字符)→ warning
- **前后缀差异**(`ABC-123` vs `SHOP-ABC-123`)→ 用最长公共子串启发式识别,info
- **A 有 B 无 / B 有 A 无**(真正的孤儿 SKU)→ critical
- **一对多**(同一 SKU 在单个源内重复出现且数量不同)→ critical

### R2. `oversell-risk` — 正在超卖的 SKU(最能打动商家)
- 任一源 `quantity <= 0` 但另一源 `> 0` → critical,"你可能正在卖已经没货的东西"
- Shopify 的 `Continue selling when out of stock` 开启 + 库存 ≤ 0 → warning
- 跨源数量差异 > 阈值(默认 5 或 20%,可配)→ 按差异幅度分级

### R3. `blank-vs-zero` — 空单元格 vs 真零
利用 `quantityRaw` 区分:CSV 里该 SKU 的数量列是空的(可能导入后被当成 0 清库存),还是明确写了 `0`。这是社区反复抱怨的"批量导入把库存清零"的根因。→ critical

### R4. `barcode-crosscheck` — 条码能匹配但 SKU 对不上
两源的 barcode 相同但 SKU 不同 → 强烈提示 SKU 映射配置错误,这类"静默失败"商家最难自己发现。→ critical

### R5. `quantity-drift` — 数量漂移分布
不针对单个 SKU,而是给出整体健康度:多少比例的 SKU 完全一致、多少有小差异、多少严重不一致。输出一个"同步健康分"。这是 README 里最好看的那个数字。

### R6. `untracked` — 未开启库存追踪
Shopify 的 `Inventory tracker` 为空/关闭但该 SKU 在另一源有库存管理 → info,提示配置不一致。

**明确不做(第一版)**:循环清零检测需要时间维度,单次两文件比对做不到。**不要在 README 里承诺这个功能**。定位成"快照差异诊断",时序检测留给 v2(本地快照历史)。

---

## 实施阶段(建议按此顺序,每阶段可独立验证)

### Phase 1:内核 + CSV 适配器(零凭据可用)
目标:`inventory-doctor diff a.csv b.csv` 能跑出报告。

1. 初始化项目:`pnpm init`,配 TypeScript(ESM,`"type": "module"`,target ES2022,`moduleResolution: "bundler"`)、`tsx` 做开发时运行、`vitest` 做测试。
2. 实现 `src/core/types.ts` 的中间表示。
3. 实现 `src/core/normalize.ts`:SKU 规范化函数(trim、大小写折叠、全角转半角、去零宽字符),**保留原始值**,规范化只用于比对不用于输出。
4. 实现 CSV 解析:用 `papaparse` 或 `csv-parse`(**必须保留空单元格与 `"0"` 的区别**,注意配置 parser 不要把空串转成 undefined/0)。
5. 实现 `src/adapters/csv/aliases.ts` 别名字典(把上面第 13 条的两套 Shopify 表头都覆盖)+ `detect.ts` 格式探测(区分商品 CSV / 库存长表 / 库存宽表 / 未知)。
6. 实现 R1–R4 四条规则 + 单元测试。
7. 实现终端报告输出。
8. 造 `fixtures/` 样例文件:**故意埋入每一种问题**(大小写失配、孤儿 SKU、空单元格、条码交叉冲突、超卖),让 `expected-report.md` 成为活文档。

**验收**:`pnpm tsx src/cli.ts diff fixtures/shopify-store-a.csv fixtures/shopify-store-b.csv` 输出的报告能命中所有埋入的问题,且 `pnpm vitest` 全绿。

### Phase 2:MCP server
1. 装 `@modelcontextprotocol/sdk@1.30.0`。
2. 实现 `src/mcp.ts`,注册工具:
   - `diff_inventory(sourceA, sourceB)` — 跑完整诊断,返回 JSON
   - `explain_sku(sku, sources)` — 单个 SKU 的跨源明细(agent 追问时用)
   - `inventory_health(sources)` — 只返回健康度摘要(轻量)
3. **严格检查:全项目 MCP 路径上不能有任何 `console.log`**。加一条 lint 规则或 grep 检查。
4. 写 `.mcp.json` 示例进 README。

**验收**:配到 Claude Code 里,能让 agent 回答"我这两个店哪些 SKU 有超卖风险"。

### Phase 3:Shopify API 适配器
1. 实现 `TokenProvider` 接口,两个实现:`StaticTokenProvider`(`shpat_`)和 `ClientCredentialsProvider`(带 24h TTL 缓存 + 提前 60s 刷新)。
2. 实现 GraphQL client:固定版本 `2026-07`,每次响应读 `throttleStatus.currentlyAvailable` 做自适应节流(可用点数低于阈值时主动 sleep),429/THROTTLED 退避 1 秒重试。
3. 实现分页拉取,推荐主查询:
   ```graphql
   query InventorySnapshot($cursor: String) {
     productVariants(first: 250, after: $cursor) {
       nodes {
         sku barcode title inventoryQuantity inventoryPolicy
         inventoryItem {
           id tracked
           inventoryLevels(first: 20, includeInactive: true) {
             nodes {
               location { id name }
               quantities(names: ["available","on_hand","committed","incoming"]) { name quantity }
             }
           }
         }
       }
       pageInfo { hasNextPage endCursor }
     }
   }
   ```
4. 配置文件设计(**凭据支持从环境变量读,不要求写进文件**):
   ```jsonc
   {
     "stores": [
       { "name": "store-a", "domain": "a.myshopify.com", "accessToken": "env:STORE_A_TOKEN" },
       { "name": "store-b", "domain": "b.myshopify.com",
         "clientId": "env:STORE_B_CLIENT_ID", "clientSecret": "env:STORE_B_SECRET" }
     ]
   }
   ```
5. CLI 支持 `inventory-doctor diff --store store-a --store store-b`(走 API)和混合模式(`--store store-a --csv b.csv`)。

**验收**:在两个 Shopify development store 上跑通(创建 dev store 必须从 Dev Dashboard 的 "Dev stores" 页,否则 client credentials 会报 `shop_not_permitted`)。

### Phase 4:打包与分发
1. `package.json` 关键字段(**采用单 bin + 子命令,不是两个 bin**):
   ```jsonc
   {
     "name": "inventory-doctor",
     "version": "0.1.0",
     "type": "module",
     "engines": { "node": ">=22" },
     "bin": { "inventory-doctor": "./dist/cli.js" },
     "files": ["dist"],
     "dependencies": {
       "@modelcontextprotocol/sdk": "1.30.0",
       "zod": "^3.25.0",
       "commander": "^12.0.0",
       "papaparse": "^5.4.0"
     }
   }
   ```
   `inventory-doctor mcp` 作为子命令启动 stdio server——这样 `.mcp.json` 只需 `"args": ["-y", "inventory-doctor", "mcp"]`,用户不必记第二个可执行名。
2. `dist/cli.js` 首行加 `#!/usr/bin/env node`。
3. README 必须包含:**样例 CSV 的诊断输出截图/代码块**(这对 star 转化影响最大)、"数据不出本机"的明确声明、`.mcp.json` 配置示例、以及诚实的限制说明(不做时序检测、client credentials 仅限同 org)。

---

## 验证方式

```bash
# 单元测试
pnpm vitest run

# 端到端(零凭据路径)
pnpm tsx src/cli.ts diff fixtures/shopify-store-a.csv fixtures/shopify-store-b.csv

# MCP server 手动验证(注意:stdout 必须是干净的 JSON-RPC)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | pnpm tsx src/mcp.ts

# 检查 MCP 路径无 stdout 污染
grep -rn "console\.log" src/ && echo "FAIL: found console.log" || echo "OK"

# API 路径(需先配好 dev store 凭据)
pnpm tsx src/cli.ts diff --store store-a --store store-b
```

**关键验证点**:
1. 空单元格与 `"0"` 必须产生不同的诊断结论(这是核心能力,要有专门的测试用例)
2. 库存 CSV 的长表和宽表都能正确解析
3. 两套 Shopify 商品 CSV 表头(旧名/新名)都能识别
4. MCP server 的 stdout 只有 JSON-RPC,日志全在 stderr
5. Shopify API 拉取在遇到限流时能自适应退避而不是崩溃

---

## 给实现者的优先级提示

如果时间有限,**Phase 1 + Phase 2 就是一个完整可发布的 v0.1**(零凭据 + MCP,足以发 HN 和 Show HN)。Phase 3 的 API 适配器是留存功能,可以在拿到第一批用户反馈后再做——但架构上从第一天就要把 adapter 层的边界划清楚,这样 Phase 3 是纯新增而不是重构。

**不要做的事**:不要在第一版加 Web UI、不要加数据库、不要做多租户(虽然决策是"预留托管版架构",但预留的方式是把 core 写成纯函数 + adapter 边界清晰,而不是提前引入租户概念)。
