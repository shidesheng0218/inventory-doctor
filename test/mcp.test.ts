import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, parseSourceArg } from '../src/mcp.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSnapshot } from '../src/snapshots.js';
import { loadCsv } from '../src/adapters/csv/index.js';

const A = 'fixtures/shopify-store-a.csv';
const B = 'fixtures/shopify-store-b.csv';

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  expect(content[0]?.type).toBe('text');
  return content[0]?.text ?? '';
}

describe('MCP tools (InMemoryTransport)', () => {
  it('diff_inventory returns the full report JSON without touching stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await withClient(async (client) => {
        const result = await client.callTool({
          name: 'diff_inventory',
          arguments: { sourceA: A, sourceB: B },
        });
        const report = JSON.parse(textOf(result)) as {
          sources: string[];
          healthScore: number;
          findings: Array<{ rule: string }>;
        };
        expect(report.sources).toEqual(['shopify-store-a', 'shopify-store-b']);
        expect(report.healthScore).toBe(33);
        expect(report.findings.length).toBeGreaterThan(10);
      });
    } finally {
      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    }
  });

  it('diff_inventory truncates findings at maxFindings and points to explain_sku', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: 'diff_inventory',
        arguments: { sourceA: A, sourceB: B, maxFindings: 3 },
      });
      const payload = JSON.parse(textOf(result)) as {
        findings: unknown[];
        totalFindings: number;
        findingsTruncated: boolean;
        nextStep: string;
      };
      expect(payload.findings).toHaveLength(3);
      expect(payload.findingsTruncated).toBe(true);
      expect(payload.totalFindings).toBeGreaterThan(3);
      expect(payload.nextStep).toContain('explain_sku');
    });
  });

  it('explain_sku returns per-source detail for one SKU', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: 'explain_sku',
        arguments: { sku: 'OVER-1', sources: [A, B] },
      });
      const explanation = JSON.parse(textOf(result)) as {
        sku: string;
        found: boolean;
        perSource: Array<{ source: string; matched: boolean; records: Array<{ quantity: number | null }> }>;
        findings: Array<{ rule: string }>;
      };
      expect(explanation.found).toBe(true);
      expect(explanation.perSource).toHaveLength(2);
      expect(explanation.perSource[0]?.records[0]?.quantity).toBe(0);
      expect(explanation.perSource[1]?.records[0]?.quantity).toBe(8);
      expect(explanation.findings.some((f) => f.rule === 'oversell-risk')).toBe(true);
    });
  });

  it('inventory_health returns the lightweight summary', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: 'inventory_health',
        arguments: { sources: [A, B] },
      });
      const health = JSON.parse(textOf(result)) as {
        healthScore: number;
        countsBySeverity: { critical: number; warning: number; info: number };
      };
      expect(health.healthScore).toBe(33);
      expect(health.countsBySeverity.critical).toBeGreaterThan(0);
    });
  });

  it('registers exactly six tools and returns an auditable, non-importable proposal', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await withClient(async (client) => {
        const list = await client.listTools();
        expect(list.tools.map((t) => t.name).sort()).toEqual([
          'diff_inventory', 'explain_sku', 'fix_export', 'inventory_health', 'sku_history', 'snapshot_check',
        ]);
        const result = await client.callTool({ name: 'fix_export', arguments: { sourceA: A, sourceB: B } });
        const payload = JSON.parse(textOf(result));
        expect(payload).toMatchObject({ reviewRequired: true, importable: false, targetSource: 'shopify-store-b', truthSource: 'shopify-store-a' });
        expect(payload.direction).toContain('not verified truth');
        expect(payload.proposals.some((p: { status: string }) => p.status === 'blocked')).toBe(true);
        expect(payload.evidence.length).toBeGreaterThan(0);
        expect(payload.risk).toBeTruthy();
        expect(payload.assumptions.length).toBeGreaterThan(0);
        expect(payload.verification.length).toBeGreaterThan(0);
        expect(payload.csv).toContain('Review status');
        const explained = JSON.parse(textOf(await client.callTool({ name: 'explain_sku', arguments: { sku: 'OVER-1', sources: [A, B] } })));
        expect(explained.findings[0]).toEqual(expect.objectContaining({ evidence: expect.any(Array), risk: expect.any(String), assumptions: expect.any(Array), verification: expect.any(Array) }));
      });
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally { stdoutSpy.mockRestore(); }
  });

  it('history and check honor windows, unknown quantities and strict numeric schemas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-snapshots-'));
    const previous = process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'];
    process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] = dir;
    try {
      for (const [i, qty] of ['12', '12', '0', ''].entries()) {
        const records = loadCsv(`Handle,Title,SKU,Variant Inventory Qty\nw,Widget,W-1,${qty}\n`, 'shop').records;
        await saveSnapshot('shop', records, new Date(`2026-09-0${i + 1}T08:00:00Z`));
      }
      await withClient(async (client) => {
        const history = JSON.parse(textOf(await client.callTool({ name: 'sku_history', arguments: { sku: 'ｗ-１', snapshotName: 'shop', maxSnapshots: 2 } })));
        expect(history.found).toBe(true);
        expect(history.points.map((p: { quantity: number | null }) => p.quantity)).toEqual([0, null]);
        const missing = JSON.parse(textOf(await client.callTool({ name: 'sku_history', arguments: { sku: 'absent', snapshotName: 'shop' } })));
        expect(missing).toMatchObject({ found: false, points: [] });
        const check = JSON.parse(textOf(await client.callTool({ name: 'snapshot_check', arguments: { snapshotName: 'shop', maxSnapshots: 2 } })));
        expect(check).toMatchObject({ totalSnapshots: 4, windowed: true, findings: [] });
        expect(check.snapshots).toHaveLength(2);
        for (const name of ['sku_history', 'snapshot_check']) {
          for (const maxSnapshots of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
            const result = await client.callTool({ name, arguments: { sku: 'W-1', snapshotName: 'shop', maxSnapshots } });
            expect(result.isError).toBe(true);
          }
        }
      });
    } finally {
      if (previous === undefined) delete process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'];
      else process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a useful error for unknown store names', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: 'inventory_health',
        arguments: { sources: ['store:no-such-store'] },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toMatch(/No config file found|not found/);
    });
  });
});

describe('parseSourceArg', () => {
  it('parses store: and plain paths', () => {
    expect(parseSourceArg('store:shop-a')).toEqual({ kind: 'store', name: 'shop-a' });
    expect(parseSourceArg('data/a.csv')).toEqual({ kind: 'csv', path: 'data/a.csv' });
    expect(() => parseSourceArg('store:')).toThrow(/store:<name>/);
  });
});
