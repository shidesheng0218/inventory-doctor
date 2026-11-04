# inventory-doctor 迭代优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按"分发加固 → agent 原生深化 → 商业化铺垫"三阶段迭代 inventory-doctor（v0.2.3 → v0.4.x），把只读审计护城河变成可分发、可被 AI agent 消费、可告警闭环的产品。

**Architecture:** 保持现有三层架构不动——`src/core/` 纯函数内核（零 I/O）、`src/adapters/` 数据源适配、`src/report/` 渲染层；CLI 与 MCP 共享 `run.ts` 入口。所有新能力以"加一个纯函数规则 / 加一个 renderer / 加一个 adapter"的方式接入，不动内核接口。

**Tech Stack:** TypeScript (strict, exactOptionalPropertyTypes) / Node >= 22 / ESM / vitest / commander / pnpm。不新增运行时依赖（webhook 用全局 `fetch`，HTML 用手写模板字符串）。

**Spec:** `docs/competitive-analysis.md`（2026-09）+ 2026-10-09 市场调研结论（agentic commerce 趋势、bundle 库存痛点、无只读审计竞品）。

## Global Constraints

- Node `>=22`（engines 已锁）；不得破坏 `npm run check:stdout`（src/ 内禁止 `console.log`，CLI 一律 `process.stdout.write`，MCP 层一切日志走 stderr）。
- core 规则必须是纯函数：签名 `(records: InventoryRecord[], options: DiagnoseOptions) => Finding[]`，无 I/O。
- `quantity: null` 与 `quantity: 0` 的区分是一等公民语义，任何新代码不得吞掉这个区别。
- `fixtures/expected-report.md` 是由测试守护的 living document——**不得改动 markdown renderer 的输出**（HTML 是新增 renderer，不动现有三个）。
- 不新增运行时依赖；新增 dev 依赖需在本计划中写明理由。
- 版本策略：Phase 1 合入后发 v0.3.0；Phase 2 合入后发 v0.4.0（package.json + `src/mcp.ts` 的 server version + CLI `.version()` 三处同步）。

## Review Focus

1. **HTML 注入**：SKU/title/source 是不可信数据（来自商家 CSV 或店铺 API），HTML 渲染必须转义一切插值——否则一份"诊断报告"本身变成 XSS 载体（本地双击打开也会中招）。
2. **快照窗口与内存**：`sku_history` 必须复用 `runSnapshotCheck` 的窗口语义，长历史上不能让内存随历史线性增长。
3. **bundle 配置的除零**：组件 required quantity 为 0 或负数时规则会除零/误判，必须在 config 加载时 fail-loud，而不是规则里默默跳过。
4. **MCP 工具注册的 stdout 纪律**：新增 `sku_history` 工具时任何日志/调试输出不得污染 JSON-RPC 通道。
5. **webhook 失败不得拖垮诊断**：通知失败只能 stderr 警告，不得改变 exit code 或中断报告输出。

---

## Phase 1 — 分发加固（目标：2 周内，发 v0.3.0）

### Task 1: HTML 报告渲染器（`--format html`）

**Files:**
- Create: `src/report/html.ts`
- Modify: `src/cli.ts:15`（`OutputFormat`）、`src/cli.ts:68`（help 文案）、`src/cli.ts:118-121`（输出选择）
- Test: `test/report-html.test.ts`

**Interfaces:**
- Consumes: `DiagnoseReport`, `Finding`, `Severity`, `HealthSummary` from `src/core/types.js`（现有）。
- Produces: `export function renderHtml(report: DiagnoseReport): string`——单文件 HTML 字符串，内联 CSS，无外部资源。

- [ ] **Step 1: 写失败测试**

`test/report-html.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/report/html.js';
import type { DiagnoseReport } from '../src/core/types.js';

const base: DiagnoseReport = {
  generatedAt: '2026-10-09T00:00:00.000Z',
  sources: ['store-a', 'store-b'],
  recordCounts: { 'store-a': 2, 'store-b': 2 },
  healthScore: 33,
  healthSummary: { matched: 0, minorDrift: 0, severeDrift: 1, unmatched: 1, totalCompared: 2 },
  findings: [
    { rule: 'oversell-risk', severity: 'critical',
      sku: '<img src=x onerror=alert(1)>',
      message: 'Sketchy "SKU" is out of stock in store-a but shows 8 in store-b',
      detail: {}, suggestion: 'Fix it' },
    { rule: 'quantity-drift', severity: 'info', sku: 'OK-1',
      message: 'Sync health score: 33/100', detail: {}, suggestion: '' },
  ],
};

describe('renderHtml', () => {
  it('escapes all untrusted interpolations (sku, message, source)', () => {
    const html = renderHtml(base);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
  it('renders health score and severity groups with counts', () => {
    const html = renderHtml(base);
    expect(html).toContain('Sync health score: 33/100');
    expect(html).toContain('Critical (1)');
  });
  it('is a self-contained document with no external resources', () => {
    const html = renderHtml(base);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).not.toMatch(/(src|href)="https?:/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/report-html.test.ts`
Expected: FAIL，`Cannot find module '../src/report/html.js'`

- [ ] **Step 3: 实现 `renderHtml` in `src/report/html.ts`**

结构：文件顶部私有 helper `escapeHtml(s: string): string`（转义 `& < > " '` 五个字符）；一个 `<style>` 块（系统字体、严重度颜色 critical=#c0392b / warning=#b58900 / info=#555、健康分进度条用纯 CSS width%）；正文：标题 + sources 表 + 健康分（数字 + 进度条 div）+ healthSummary 表 + 按严重度分组的 findings 表（列：rule / sku / message / suggestion）。`sku` 为 `null` 时渲染 `—`。模板字符串拼接，所有插值过 `escapeHtml`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/report-html.test.ts && npm test`
Expected: 全部 PASS（137 + 3 新测试）

- [ ] **Step 5: 接入 CLI**

`src/cli.ts`：`:15` 改为 `type OutputFormat = 'terminal' | 'json' | 'markdown' | 'html'`；`:68` help 改为 `'output format: terminal | json | markdown | html'`；`:119-120` 输出选择加 `format === 'html'` 分支（`renderHtml(report)`，注意 `+ '\n'` 保持与其他格式一致的行为）。

- [ ] **Step 6: e2e 验证**

Run: `npx tsx src/cli.ts diff fixtures/shopify-store-a.csv fixtures/shopify-store-b.csv --format html > /tmp/r.html && open /tmp/r.html`
Expected: 浏览器打开显示分组报告，exit code 1（critical 存在）。

- [ ] **Step 7: Commit**

```bash
git add src/report/html.ts src/cli.ts test/report-html.test.ts
git commit -m "feat(report): self-contained HTML report via --format html"
```

### Task 2: GitHub Action 模板

**Files:**
- Create: `action.yml`（仓库根，composite action）
- Create: `.github/workflows/example-inventory-check.yml`（自用之：每天对 fixtures 跑一次，验证 action 的命令行契约）
- Create: `test/action-smoke.test.ts`
- Modify: `README.md`（CI 一节加一段）

**Interfaces:**
- Consumes: Task 1 之后 CLI 的全部 flag 形态（不变）。
- Produces: composite action `inventory-doctor`，inputs：`source-a`、`source-b`（必填）、`config`（可选）、`format`（默认 `terminal`）、`extra-args`（可选）、`fail-on-critical`（默认 `'true'`）；output：`report`（报告文件路径）。

- [ ] **Step 1: 写失败测试（smoke）**

`test/action-smoke.test.ts`：用 `node:child_process` 的 `execFileSync` 执行 `npx tsx src/cli.ts diff fixtures/shopify-store-a.csv fixtures/shopify-store-b.csv --format markdown`，断言 exit code 为 1（用 `try/catch` 捕获 status）、stdout 含 `CRITICAL`。这一步验证的是 action 将要执行的命令行契约本身；YAML 结构靠 Step 3 的人工核对清单保证（不引入 YAML 解析 dev 依赖，YAGNI）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/action-smoke.test.ts`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现 `action.yml`**

composite action，steps：
1. `actions/setup-node@v4`（`node-version: 22`）
2. `run:` `npx -y inventory-doctor@${{ inputs.version }} diff "${{ inputs.source-a }}" "${{ inputs.source-b }}" --format "${{ inputs.format }}" ${{ inputs.extra-args }} > inventory-doctor-report.txt`，`shell: bash`；`inputs.version` 默认 `0.3.0`；环境变量透传 `env:` 块（`SHOPIFY_CLIENT_SECRET: ${{ secrets.SHOPIFY_CLIENT_SECRET }}` 等按 README 已有 env 名）
3. `if: always()` 的 `actions/upload-artifact@v5`（`path: inventory-doctor-report.txt`，`if-no-files-found: ignore`）
4. `fail-on-critical == 'true'` 时由 step 2 的天然 exit code 达成（CLI 已有 critical→1 语义），不需要额外逻辑。

同时写 `.github/workflows/example-inventory-check.yml`：schedule cron（`17 3 * * *`，错开整点）+ workflow_dispatch，job 里 `uses: ./` 调用本 action，source 用 fixtures 两个 CSV，`fail-on-critical: false`（示例库自身 fixtures 故意含 critical，不能把自己 CI 打红）。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `npx vitest run test/action-smoke.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: README 加 CI 一节**

在 "Snapshots" 一节之后插入：GitHub Action 用法示例（marketplace 引用语法 `uses: shidesheng0218/inventory-doctor/<action-path>@v0.3.0`）、secret 配置、`fail-on-critical` 说明（exit 1 → workflow 红）。

- [ ] **Step 6: Commit**

```bash
git add action.yml .github/workflows/example-inventory-check.yml test/action-smoke.test.ts README.md
git commit -m "feat(ci): composite GitHub Action + self-checking example workflow"
```

### Task 3: 定位文案 + nightly-zero 演示资产

**Files:**
- Create: `docs/example-nightly-zero.md`（含生成步骤，非生成产物本身）
- Modify: `README.md:9` 附近（"Not a sync tool" 段落扩展）

**Interfaces:**
- Produces: README 新段落 + 可复现的演示命令（供截图/录屏营销素材，产物不入库）。

- [ ] **Step 1: README 定位段落扩展**

在 `README.md:9` "Not a sync tool" 段后加一段（英文，README 主体语言）：agentic commerce 语境下单次超卖成本上升（AI 买家流量 393% YoY、取消零容忍），同步引擎都在写你的库存，而**每个同步工具的用户都需要一个独立审计层**——inventory-doctor 是唯一的只读 reconciliation 层；附 `docs/competitive-analysis.md` 链接。

- [ ] **Step 2: 写 `docs/example-nightly-zero.md`**

内容：用 fixtures 复现"夜里被静默清零"场景的可复现命令序列——对 `fixtures/shopify-store-a.csv` 连续 3 天 `snapshot save --name demo`，第 3 天把某 SKU 数量改成 0 后再次 save，然后 `snapshot check demo`，展示 nightly-zero 的 critical 输出。注明这是营销演示素材的生成 SOP。

- [ ] **Step 3: 手动验证命令序列**

Run: 按 `docs/example-nightly-zero.md` 的命令在临时 `INVENTORY_DOCTOR_SNAPSHOT_DIR` 下走一遍
Expected: 第 3 次 check 出现 critical 级 nightly-zero finding。

- [ ] **Step 4: Commit**

```bash
git add README.md docs/example-nightly-zero.md
git commit -m "docs: agentic-commerce positioning + reproducible nightly-zero demo"
```

### Task 4: 发版 v0.3.0

- [ ] **Step 1:** `package.json` version → `0.3.0`；`src/cli.ts:57` `.version('0.3.0')`；`src/mcp.ts:18` server version `'0.3.0'`。
- [ ] **Step 2:** `npm test && npm run build && npm run check:stdout` 全绿。
- [ ] **Step 3:** `git commit -m "chore(release): v0.3.0"` + `git tag v0.3.0` + `pnpm publish`（prepublishOnly 会自动 build+test）。

---

## Phase 2 — agent 原生深化（目标：4–6 周，发 v0.4.0）

### Task 5: 快照窗口抽取 + `sku_history`（对话式根因分析的时间维度）

**Files:**
- Modify: `src/snapshots.ts`（抽取 `loadSnapshotWindow`）、`src/run.ts:264-290`（`runSnapshotCheck` 改用之）
- Create: `src/history.ts`
- Modify: `src/mcp.ts`（新工具）、`src/cli.ts`（`snapshot history` 子命令）
- Test: `test/history.test.ts`

**Interfaces:**
- Produces:
  - `snapshots.ts`: `export async function loadSnapshotWindow(name: string, maxSnapshots?: number): Promise<LoadedSnapshot[]>`（`LoadedSnapshot` 即 `loadSnapshot` 的返回类型，需从 snapshots.ts 导出该类型名）。
  - `history.ts`: `export interface SkuHistoryPoint { snapshotId: string; savedAt: string; location: string | null; quantity: number | null }`、`export interface SkuHistory { sku: string; canonical: string; found: boolean; points: SkuHistoryPoint[] }`、`export async function skuHistory(sku: string, name: string, options?: { maxSnapshots?: number }): Promise<SkuHistory>`。
  - MCP 工具 `sku_history(sku, snapshotName, maxSnapshots?)`：返回该 SKU 在快照历史里的逐时间点数量序列（含 location 维度，quantity 保留 null/0 区别）。
- 关键决策：`points` 按 (snapshotId, location) 展开；canonical 匹配复用 `normalizeSku`；`found=false` 时 `points` 为空数组（不抛错，agent 友好）。

- [ ] **Step 1:** 失败测试 `test/history.test.ts`：用 `INVENTORY_DOCTOR_SNAPSHOT_DIR` 指向临时目录，save 3 个快照（某 SKU 数量 5→5→0），断言 `skuHistory` 返回 3 个 point 且最后一个 `quantity === 0`；断言 window=2 时只返回后 2 个；断言 blank（`quantity: null`）在 point 中保持 `null`。
- [ ] **Step 2:** 确认失败 → **Step 3:** 实现（先抽取 `loadSnapshotWindow`，`runSnapshotCheck` 改为调用它——行为不变，`test/snapshot-window.test.ts` 必须原样通过）→ **Step 4:** 全量测试通过 → **Step 5:** MCP 工具注册 + CLI `snapshot history <name> <sku> [--window <n>]` → **Step 6:** commit `feat(history): per-SKU time-series across snapshots (CLI + MCP sku_history)`。

### Task 6: `bundle-availability` 规则

**Files:**
- Modify: `src/core/types.ts`（`BundleDef`/`BundleComponent` + `DiagnoseOptions.bundles?`）、`src/config.ts`（`Config.bundles?` + `validateBundles` fail-loud）、`src/core/diagnose.ts`（注册规则）、`src/core/rules/bundle-availability.ts`、`src/run.ts:134-148`（`resolveDiagnoseOptions` 透传）
- Test: `test/core/bundle-availability.test.ts`、`test/config.test.ts`（追加校验用例）

**Interfaces:**
- Produces:
  - `export interface BundleComponent { sku: string; quantity: number }`（`quantity` = 组装一个 bundle 需要的组件数，>=1）
  - `export interface BundleDef { sku: string; components: BundleComponent[] }`
  - `export function bundleAvailability(records: InventoryRecord[], options: DiagnoseOptions): Finding[]`——`options.bundles` 为空/未定义时返回 `[]`（规则默认静默，老用户零感知）。
- 规则逻辑：按 source 分组 → 对每 (source, location)（无 location 维度时用跨仓总和）：`computedMax = min(floor(componentQty / required))`；bundle 自身 listed quantity > 0 且 computedMax = 0 → **critical**（bundle 挂着可售但组件已撑不起）；|listed − computedMax| 超 drift 阈值 → **warning**。组件在源里缺失 → **warning**（"组件缺失，无法计算 bundle 可售量"），不算进 min。
- 关键决策：`validateBundles` 在 `loadConfig` 时抛错：`quantity < 1`、`components` 为空、同一 bundle sku 重复定义——fail-loud，不搞规则内静默跳过。

- [ ] **Step 1:** 失败测试：bundle 可售计算正确（1 bundle = 1xA + 2xB，A=5、B=5 → computedMax=2）；listed=3 vs computed=2 出 warning；listed=1、B=0 出 critical；组件缺失出 warning；`bundles` 未定义时 `diagnose()` 输出与现状逐字节一致（防回归锚点）。
- [ ] **Step 2-4:** 确认失败 → 实现 → 全量测试（含既有 137 个原样通过）。
- [ ] **Step 5:** config 校验测试（quantity=0 抛错文案固定）。
- [ ] **Step 6:** README "The eight diagnostic rules" 表加第九行 + config 示例加 `bundles` 字段 → **Step 7:** commit `feat(core): bundle-availability rule — catch bundles listed sellable while components can't support them`。

### Task 7: webhook 告警（`snapshot check --webhook`）

**Files:**
- Create: `src/notify.ts`
- Modify: `src/cli.ts`（`snapshot check` 加 `--webhook <url>`）、`src/config.ts`（可选 `notify.webhookUrl`）
- Test: `test/notify.test.ts`（本地起 `node:http` server 断言 POST body 与 Content-Type）

**Interfaces:**
- Produces: `export async function sendWebhook(url: string, payload: { name: string; critical: number; warning: number; findings: Array<{ severity: string; message: string }> }, options?: { timeoutMs?: number }): Promise<void>`——失败一律抛给调用方；CLI 层 catch 后 stderr 警告、**不改变 exit code**。
- 关键决策：仅在有 critical finding 时发送（warning-only 不发，避免告警疲劳）；10s 超时；用全局 `fetch`，零新依赖。

- [ ] **Step 1:** 失败测试：server 收到 1 次 POST、body JSON 含 `critical: 1`、Content-Type `application/json`；server 挂掉（连不上）时 CLI 层 catch 后 exit code 仍为 1（critical 语义不被通知失败覆盖）。
- [ ] **Step 2-6:** 失败 → 实现 `src/notify.ts` + CLI/config 接线 → 全量测试 → README Snapshots 一节加 webhook 示例 → commit `feat(notify): webhook alert on critical snapshot-check findings`。

### Task 8: 发版 v0.4.0

同 Task 4 流程（三处版本号 + tag + publish）。

---

## Phase 3 — 覆盖与商业化铺垫（目标：Q1 2027，单独出计划）

以下每项范围都够一份独立 plan，届时按同一模板展开（TDD、接口先行）：

1. **Amazon SP-API adapter**（最大渠道缺口）。真正的成本在 auth：LWA token 交换 + 请求签名（SP-API 要求 SigV4 风格签名，要么手写 HMAC 实现——约 200 行、零依赖，要么破例引入 `aws4` 一个依赖）。建议先出 spike 计划评估手写签名 vs 引依赖，再出实现计划。数据源形态上 SP-API 没有"全量库存表"接口，走 Reports API 异步拉取，意味着 adapter 内部需要轮询任务状态——这与现有同步式 adapter 的 `fetchInventory()` 形态不同，接口设计要先定。
2. **托管版（hosted app）**：scheduling/历史/告警/多源的无聊部分做 SaaS，引擎永远开源本地。商业模式：按店订阅 $10–20/月。技术决策点：快照存储从本地 JSONL 换到服务端后，`loadSnapshot` 的抽象边界是否需要上提为 `SnapshotStore` 接口（本地 fs 实现 + 远端实现）——这是 Phase 3 唯一可能触及现有架构的点，先出架构设计文档再动手。
3. **BigCommerce / Etsy adapter**：验证"加 adapter 不重构"承诺的低成本动作，顺手补渠道覆盖叙事。

## Self-Review 记录

- **Spec 覆盖**：上一轮分析的建议 1（HTML）、2（Action）、4（MCP 深化）、5（bundle）、6（SP-API）、7（托管模式）各有任务；建议 3（营销钩子）落在 Task 3；建议 8（战略纪律）不在代码计划内。
- **Step 粒度**：Phase 1 全步骤化；Phase 2 按技能要求每个任务保留独立测试循环，细节留给执行时展开（接口与关键决策已钉死，不会出现"TBD"）；Phase 3 明确标注为单独计划。
- **类型一致性**：`BundleDef` 定义在 `core/types.ts`（config.ts 导入，避免循环依赖）；`loadSnapshotWindow` 的返回类型复用 `loadSnapshot` 返回值；`sku_history` 的 MCP 参数名与 CLI 参数名一致（`maxSnapshots` ↔ `--window` 值语义一致）。
- **Review Focus 落测试**：HTML 转义→Task 1 测试 1；窗口内存→Task 5 window 断言；除零→Task 6 config 校验测试；stdout 纪律→Task 5 的 MCP 注册沿用 `check:stdout` 守护（新增代码禁 `console.log`）；webhook 失败语义→Task 7 测试 2。
- **比例**：Phase 2/3 刻意粗于 Phase 1，符合"plan 不是代码转录"的要求。
