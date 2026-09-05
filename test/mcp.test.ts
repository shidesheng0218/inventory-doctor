import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, parseSourceArg } from '../src/mcp.js';

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
      expect(health.countsBySeverity.critical).toBe(8);
    });
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
