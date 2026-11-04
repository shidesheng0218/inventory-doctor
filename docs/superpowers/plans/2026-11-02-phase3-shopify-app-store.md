# inventory-doctor Phase 3 — Shopify 上架（Hosted App）Implementation Plan（草稿）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：草稿（v0.1，2026-11-02），尚未经过试点门槛确认，动手前先读 §0 的启动条件。**

**Goal:** 把 inventory-doctor 从"分发型开发工具"（npm/CLI/MCP/GitHub Action）升级为可上架 Shopify App Store 的托管 App：标准 OAuth 安装流 + 强制合规 webhook + 服务端调度/历史/告警 + Billing 订阅变现，同时引擎保持开源、只读、本地可审计。

**Architecture:** 不动现有三层内核（`src/core/` 纯函数、零 I/O；`src/adapters/` 数据源；`src/report/` 渲染）。hosted app 作为**独立部署单元**复用引擎：新增 `SnapshotStore` 抽象（本地 fs 实现保留给 CLI，远端实现给服务端）；新增 `src/hosted/`（或服务端仓库）承载 HTTP 层、OAuth 安装回调、webhook 接收器、调度器、计费。诊断逻辑一律经由 `runDiff` / `runSnapshotCheck` / `inventoryHealth` 等既有入口调用，hosted 层只做 IO 编排与持久化。

**Tech Stack:** TypeScript (strict, exactOptionalPropertyTypes) / Node >= 22 / ESM。HTTP 层选型待定（见 Task 3 的 spike），候选：原生 `node:http`（零依赖，沿用 CLI 的 stdout/隐私纪律）或 Hono/Fastify（需评估依赖许可与审计成本——现状 `package.json` 运行时依赖仅 4 个：commander / papaparse / zod / @modelcontextprotocol/sdk）。数据库与队列在架构设计文档中定（Task 2）。

**Spec:**
- `docs/competitive-analysis.md`（2026-09）：定位与护城河（只读审计 vs 写操作同步）。
- `docs/pilot-validation.md`：**上架前的验收门槛，未全部通过前不进入 Phase 3 实现**。
- `docs/superpowers/plans/2026-10-09-iteration-optimization.md` Phase 3 §2：托管版构想（$10–20/店/月订阅；`SnapshotStore` 抽象是唯一既定技术决策）。
- Shopify 官方要求（提交前以最新文档为准）：<https://shopify.dev/docs/apps/launch>。

---

## §0 启动条件（Gate）—— 不满足不得开工

Phase 3 是本项目**最贵的投入**（引入服务端、多租户、计费、合规）。按 `docs/pilot-validation.md:22` 的既定纪律：

- [ ] **G1 试点验证**：3 个真实用户试点会话已完成并有记录（单店运营 / 多仓运营 / 开发者或 agency 各一），且出现**重复使用**与**明确的托管调度需求**。星标数与下载量不构成替代证据。
- [ ] **G2 Shopify 只读实测**：在授权开发店 + 新轮换凭据下，token 交换、只读 scope、跨 ≥2 location 的已知 SKU 数量与 Admin UI 一致；>20 location 路径如无法实测须在 README/计划中标注为"仅单元测试覆盖"。
- [ ] **G3 需求确认**：至少一个试点对象明确表示愿意为"定时跑 + 历史 + 告警"付费，或同类信号的付费意向访谈 ≥3 个。

G1–G3 任一不满足 → 停在当前开源形态，继续 Phase 1/2 式迭代（补渠道 adapter、打磨 MCP），**不要**为避免"浪费已写计划"而开工。本计划的全部任务以 Gate 通过为前提。

---

## §1 现状盘点（v0.5.0 已具备 / 缺口对照）

已具备（直接复用，不重写）：

- **诊断内核**：9 条规则 + health score + evidence/risk/assumptions/verification 四元组（`src/core/`）。
- **Shopify 读取**：GraphQL Admin API 2026-07、`quantities(names:[...])`、自适应限流（读 `throttleStatus`）、429/网络瞬断 1s 退避、30s 超时（`src/adapters/shopify-api/`）。
- **三种凭据模式**：静态 token / client credentials / loopback OAuth 离线 token（`src/config.ts`、`src/adapters/shopify-api/oauth.ts`）。
- **快照与告警**：JSONL 本地快照、`--window` 内存恒定时序检查、webhook 通知（critical-only，失败只 stderr 不改 exit code）（`src/snapshots.ts`、`src/notify.ts`）。
- **域名校验**：`validateShopifyDomain` 已防任意 host（`src/adapters/shopify-api/domain.ts`）。

缺口（本计划要补的）：

| 层 | 缺什么 |
|---|---|
| 产品 | 服务端调度、快照历史存服务端、多租户隔离、告警闭环（重试/历史/多渠道）、finding 审查 UI |
| 合规 | 标准 embedded OAuth 安装流（区别于现有 loopback 一次性流）、三个强制 webhook（`customers/data_request`、`customers/redact`、`shop/redact`）、`app/uninstalled` 清理、隐私政策、审核材料、scope 用途说明 |
| 变现 | Shopify Billing（Managed Pricing 优先）、免费层/试用、按店计费边界 |

---

## §2 Global Constraints

1. **引擎永远开源、只读、本地可跑**：hosted 层不得引入对 Shopify/任何 commerce API 的**写**调用；诊断结果的唯一写出口仍是本地文件或用户显式配置的 webhook。README 第 9 行的承诺（"never writes inventory to a commerce API"）对 hosted 版同样成立——它读、存快照、发告警，仅此而已。
2. **`quantity: null` ≠ `0`**：任何快照存储/传输格式（含远端 DB 序列化）必须保留 null，`blank-vs-zero` 的语义不得在 hosted 路径被吞。
3. **stdout 纪律**：`src/` 内禁止 `console.log`（`npm run check:stdout` 守护）；hosted HTTP 层的访问日志一律 stderr 或结构化日志通道，绝不进诊断 payload。
4. **凭据不出边界**：`env:VAR_NAME` 引用语义保留；hosted 服务端存储的 token 必须加密（见 Task 6），且与 CLI 的 `oauth-tokens.json`（本地 0600）是**两套独立存储**，CLI 行为零变化。
5. **版本单一来源**：`package.json` 仍是唯一版本源，hosted 组件如独立发版需新增 `sync-version` 目标并在 `check:versions` 中强制。
6. **审核红线**：列表文案不得暗示 Shopify 背书；不得爬取/批量联系商家；遵守 `docs/pilot-validation.md` 的邀请纪律。

---

## §3 Review Focus（实现前必读）

1. **OAuth state 与 HMAC**：安装回调必须校验 `state`（防 CSRF）与 Shopify 的 HMAC 签名（query 与 webhook body 都验）。现有 loopback 流（`oauth.ts` 的 `waitForCallback`）只校验 state，**不能**直接搬到服务端——服务端要额外验 HMAC 和 host。
2. **强制 webhook 的应答语义**：`customers/data_request` / `customers/redact` / `shop/redact` 必须在 Shopify 规定时限内以 200 应答（异步处理），且 `shop/redact` 触发后**真的删**该 shop 的 token、快照、历史。答了 200 但没删 = 审核拒绝 + 合规事故。
3. **多租户隔离**：快照/配置/finding 按 shop 隔离；任何按 `sourceName` 定位资源的代码路径在 hosted 下都要先过"该 shop 是否拥有该 source"的鉴权，防 IDOR。
4. **调度的幂等与漂移**：每日诊断任务必须幂等（同一 shop 同一天重跑不产生重复快照），且调度器要能容忍 worker 重启（at-least-once + 去重，而非 at-most-once）。
5. **Billing 的状态机**：订阅状态（active/canceled/declined/expired）以 Shopify 回调为准，本地不臆测；未付费店铺只读功能可降级但**不得**偷偷停止已承诺的告警而不告知。

---

## §4 任务分解

> 粒度说明：Task 1–3 为设计与决策（产出文档/spike），Task 4–9 为实现（TDD、接口先行）。每个实现任务遵循：失败测试 → 实现 → 全量回归 → 文档 → commit。

### Task 1: 上架范围决策（半页 ADR）

- [ ] 决定首发形态：**(a) 完整 SaaS**（调度+历史+告警+计费），还是 **(b) 免费配套 App**（只做 OAuth 安装 + 凭据代管，诊断仍在用户本地/CI 跑，作为低门槛中间态）。
- [ ] 记录定价假设（$10–20/店/月 的起点）、免费层边界（如：手动 diff 免费，每日调度 + 历史收费）。
- [ ] 产出：`docs/superpowers/plans/phase3/adr-001-scope.md`，含明确"不做什么"（首发不做：Amazon adapter、套餐捆绑、agency 多店 dashboard）。

### Task 2: Hosted 架构设计文档（先设计后编码）

- [ ] **`SnapshotStore` 抽象**：把 `loadSnapshot` / `listSnapshotStubs` / `saveSnapshot` 的边界上提为接口（本地 fs 实现保留，远端实现新增）。关键决策：远端快照的序列化格式必须保留 `quantity: null` 与 `quantityBasis`（Global Constraint 2）。
- [ ] **多租户数据模型**：shop → stores → snapshots → findings 的关系与隔离键。
- [ ] **调度器拓扑**：cron 触发 → 队列 → worker 执行 `runSnapshotCheck` → 落库 + 触发告警；幂等键设计（shop + date）。
- [ ] **技术选型**：HTTP 框架（原生 `node:http` vs Hono/Fastify，评估依赖许可与审计成本）、DB（SQLite 起步 vs Postgres）、队列（DB 轮询 vs 独立队列）。
- [ ] 产出：`docs/superpowers/plans/phase3/architecture.md`，含一张数据流图与"哪些复用 `src/run.ts` 入口"的显式清单。

### Task 3: OAuth 安装流 spike（验证可行性，不写产品码）

- [ ] 在开发店上验证：embedded 安装回调 → `state` + HMAC 校验 → 换 offline token → 落库 → `app/uninstalled` webhook 清理。
- [ ] 结论记录：现有 `exchangeCodeForToken`（`oauth.ts:41`）能否原样复用（大概率能，它已是纯函数 + 可注入 `fetchFn`），`waitForCallback` 的 loopback 部分确认**不复用**（那是 CLI 形态）。
- [ ] 产出：spike 笔记 + 一个可删除的最小回调 demo（不进主干）。

### Task 4: 强制合规 webhook（TDD）

**Files:**
- Create: `src/hosted/webhooks/mandatory.ts`（`customers/data_request`、`customers/redact`、`shop/redact` 的 HMAC 校验 + 应答 + 异步清理派发）
- Create: `src/hosted/webhooks/app-uninstalled.ts`
- Test: `test/hosted/mandatory-webhooks.test.ts`（伪造 Shopify HMAC 头、断言 200 应答时序与清理副作用）

**Interfaces:**
- Consumes: Shopify webhook POST（`X-Shopify-Hmac-Sha256`、`X-Shopify-Shop-Domain`）。
- Produces: `export function verifyWebhookHmac(rawBody: Buffer, secret: string, header: string): boolean`（时序安全比较）；`export async function handleMandatoryWebhook(...)` → 200 立即应答 + 入队清理任务。
- 关键决策：HMAC 用**原始字节**算（不能 JSON.parse 再 stringify）；清理任务 at-least-once + 幂等。

- [ ] **Step 1:** 失败测试：合法 HMAC → 200 + 清理任务入队；篡改 body → 401；`shop/redact` 后该 shop 的 token/快照/历史在 DB 中不可读。
- [ ] **Step 2–4:** 确认失败 → 实现 → 全量测试。
- [ ] **Step 5:** README（hosted 章）写明"我们处理这三个 webhook 的行为"。
- [ ] **Step 6:** commit `feat(hosted): mandatory GDPR webhooks (data_request/redact/shop.redact) with HMAC verification`。

### Task 5: 标准 OAuth 安装流（embedded，TDD）

**Files:**
- Create: `src/hosted/auth/install.ts`（发起）、`src/hosted/auth/callback.ts`（state+HMAC+host 校验、换 token、加密落库）
- Modify: 复用 `src/adapters/shopify-api/oauth.ts` 的 `exchangeCodeForToken` / `buildAuthorizeUrl` / `DEFAULT_SCOPES`
- Test: `test/hosted/install-flow.test.ts`

**Interfaces:**
- Produces: `export async function startInstall(shop: string): { redirectTo: string }`；`export async function handleCallback(query: ...): Promise<{ shop: string }>`（失败抛错，不静默重定向）。
- 关键决策：token 入库前**加密**（见 Task 6 的 KMS/信封加密）；`state` 一次性、短时（≤10min）、绑定 shop。

- [ ] **Step 1:** 失败测试：完整回调链路（合法 state+HMAC → token 落库且密文不可逆读出明文）；state 重放 → 拒绝；HMAC 不符 → 拒绝。
- [ ] **Step 2–5:** 实现 → 回归 → 文档 → commit `feat(hosted): embedded OAuth install flow with encrypted token storage`。

### Task 6: 凭据加密与密钥管理

- [ ] 决定加密方案：信封加密（数据密钥 + 主密钥）+ 主密钥来源（云 KMS / 本地密钥文件二选一，首发可用本地 0600 密钥文件 + 文档化轮换流程）。
- [ ] 失败测试：密文不含明文 token；换主密钥后旧密文可解（轮换窗口）或明确不可解 + 强制重授权。
- [ ] commit `feat(hosted): envelope encryption for stored store credentials`。

### Task 7: 服务端调度 + 快照历史 + 告警闭环（TDD）

**Files:**
- Create: `src/hosted/scheduler.ts`（cron → 队列 → worker）、`src/hosted/snapshot-store-remote.ts`（`SnapshotStore` 远端实现）
- Modify: `src/snapshots.ts` 上提接口（**不动 CLI 默认行为**）
- Test: `test/hosted/scheduler.test.ts`（幂等：同 shop 同日重跑 → 快照去重；worker 崩溃 → at-least-once 重投）

**Interfaces:**
- Produces: `export interface SnapshotStore { save(name, records): Promise<SnapshotInfo>; stubs(name): Promise<SnapshotStub[]>; load(ref): Promise<LoadedSnapshot>; window(name, max): Promise<LoadedSnapshot[]> }`（签名对齐现有 `src/snapshots.ts`，本地实现直接适配）。
- 关键决策：告警沿用 critical-only 语义（`notify.ts`），但 hosted 版加重试队列与告警历史表；失败的告警可见于 dashboard，不静默丢。

- [ ] **Step 1:** 失败测试：调度幂等、窗口语义与 CLI 一致（`--window` 内存恒定承诺在远端同样成立）、critical-only 告警、失败告警留痕。
- [ ] **Step 2–5:** 实现 → 回归 → 文档 → commit `feat(hosted): scheduled daily reconciliation with remote snapshot store and alert history`。

### Task 8: Billing（Managed Pricing 优先，TDD）

- [ ] 选型：优先 Shopify **Managed Pricing**（托管定价页，Shopify 托管计费 UI），降级方案才是 RecurringApplicationCharge 自建。
- [ ] 失败测试：订阅 active → 解锁调度；canceled/declined → 降级为只读 + 明确告知（不静默停告警）；状态以回调为准。
- [ ] 按店计费边界：一个商家多店 = 多订阅或一订阅多店（在 Task 1 ADR 已定）。
- [ ] commit `feat(hosted): Shopify Managed Pricing subscription with entitlement gating`。

### Task 9: 上架材料与提交

- [ ] **列表文案**：突出"只读审计层"差异化（对照 `docs/competitive-analysis.md`），写明"不写库存"。
- [ ] **截图/演示视频**：CLI demo → hosted dashboard 的健康分趋势与 finding 审查。
- [ ] **隐私政策**：新写 hosted 版（本地工具的"数据不出本机"叙事**不适用**于 hosted——明确存什么、存多久、怎么删）。
- [ ] **scope 用途说明**：`read_inventory / read_products / read_locations` 逐一在 Partners Dashboard 写明。
- [ ] **测试店铺**：给审核员一个预置 fixtures 数据的开发店。
- [ ] **自我审核清单**：对照 <https://shopify.dev/docs/apps/launch> 的 latest 要求逐条勾。
- [ ] commit `chore(launch): app store listing assets, privacy policy, submission checklist`。

---

## §5 与既有路线的关系

- **不替代 Phase 1/2**：Amazon SP-API、BigCommerce/Etsy adapter 仍是独立计划，可与 Phase 3 并行（它们只加 adapter，不碰 hosted 层）。
- **CLI/开源版永存**：hosted 是增量，不是迁移。README 的 "Who this is for" 双轨定位（开发者跑引擎 / 商家用托管）是产品承诺，本计划不得破坏。
- **唯一可能触及现有架构的点**：`SnapshotStore` 抽象（Task 2/7）。任何超出此处的 `src/core/` 改动都要回到架构设计文档重议。

---

## Self-Review 记录

- **Spec 覆盖**：`pilot-validation.md` 的三道门槛 → §0 Gate；competitive-analysis 的差异化 → Task 9 文案与 Global Constraint 1；iteration-optimization Phase 3 §2 的 `SnapshotStore` 决策 → Task 2/7。
- **只读承诺**：Global Constraint 1/2/3 直接翻译了 README 与类型层的既有纪律（null≠0、stdout 纪律、不写 commerce API）。
- **合规硬门槛**：Review Focus 1/2 把"loopback OAuth 不能直接搬服务端"和"强制 webhook 答 200 必须真删"两个最易翻车点前置。
- **诚实声明**：Shopify 上架要求细节（审核时限、Managed Pricing 的具体能力边界）以提交时 shopify.dev 最新文档为准；本环境无法联网核验，Task 9 的自我审核清单是最终防线。
- **刻意留白**：HTTP 框架/DB/队列不定死在计划里（Task 2 的 ADR 决定），避免在未验证试点前锁定昂贵决策。
