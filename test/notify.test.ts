import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InventoryRecord } from '../src/core/types.js';
import { saveSnapshot } from '../src/snapshots.js';
import { sendWebhook } from '../src/notify.js';

// Real local node:http servers — no fetch mocks. The CLI scenarios exec the
// real CLI (like action-smoke.test.ts) so the "webhook failure must not
// override the critical exit code" contract is exercised end to end.

let root = '';
const NAME = 'notify-test';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: string;
}

let server: Server;
let requests: CapturedRequest[] = [];
let baseUrl = '';

let hangingServer: Server;
let hangingUrl = '';

function rec(quantity: number): InventoryRecord {
  return {
    source: NAME,
    sku: 'SKU-1',
    barcode: null,
    title: null,
    location: null,
    quantity,
    quantityRaw: String(quantity),
    tracked: true,
    meta: {},
  };
}

async function seed(quantities: number[]): Promise<void> {
  for (const [index, quantity] of quantities.entries()) {
    await saveSnapshot(NAME, [rec(quantity)], new Date(Date.UTC(2026, 0, index + 1, 9, 0, 0)));
  }
}

// Async spawn (not spawnSync): the webhook target is an HTTP server in THIS
// process, and spawnSync would block the event loop that has to answer.
function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'src/cli.ts', ...args], {
      env: { ...process.env, INVENTORY_DOCTOR_SNAPSHOT_DIR: root },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'invdoc-notify-'));
  process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] = root;

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A server that accepts but never answers — for the timeout test.
  hangingServer = createServer(() => {
    /* never respond */
  });
  await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', resolve));
  hangingUrl = `http://127.0.0.1:${(hangingServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
  delete process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'];
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  requests = [];
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
});

describe('sendWebhook', () => {
  const payload = {
    name: 'notify-test',
    critical: 1,
    warning: 0,
    findings: [{ severity: 'critical', message: 'SKU-1 was zeroed' }],
  };

  it('POSTs JSON with Content-Type application/json and resolves on 2xx', async () => {
    await sendWebhook(`${baseUrl}/hook`, payload);

    expect(requests).toHaveLength(1);
    const req = requests[0] as CapturedRequest;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/hook');
    expect(req.contentType).toBe('application/json');
    expect(JSON.parse(req.body)).toEqual(payload);
  });

  it('throws on non-2xx responses', async () => {
    const failing = createServer((req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;
    await expect(sendWebhook(url, payload)).rejects.toThrow(/500/);
    await new Promise<void>((resolve) => failing.close(() => resolve()));
  });

  it('throws when the server is unreachable', async () => {
    await expect(sendWebhook('http://127.0.0.1:1/hook', payload)).rejects.toThrow();
  });

  it('throws when the request exceeds timeoutMs', async () => {
    await expect(sendWebhook(hangingUrl, payload, { timeoutMs: 100 })).rejects.toThrow();
  });
});

describe('snapshot check --webhook', () => {
  it('sends one alert on critical findings and still exits 1', async () => {
    await seed([20, 20, 0]); // nightly-zero critical: stable stock, cliff to 0

    const { status, stdout } = await runCli(['snapshot', 'check', NAME, '--webhook', `${baseUrl}/hook`]);

    expect(status).toBe(1);
    expect(stdout).toContain('CRITICAL');
    expect(requests).toHaveLength(1);
    const body = JSON.parse((requests[0] as CapturedRequest).body) as Record<string, unknown>;
    expect(body['name']).toBe(NAME);
    expect(body['critical']).toBe(1);
    expect(Array.isArray(body['findings'])).toBe(true);
  });

  it('keeps exit code 1 when the webhook is unreachable (failure is stderr-only)', async () => {
    await seed([20, 20, 0]);

    const { status, stderr } = await runCli(['snapshot', 'check', NAME, '--webhook', 'http://127.0.0.1:1/hook']);

    expect(status).toBe(1);
    expect(stderr).toMatch(/webhook/i);
  });

  it('does not send on warning-only findings', async () => {
    await seed([20, 20, 10]); // nightly-zero warning: halved, not zeroed

    const { status, stdout } = await runCli(['snapshot', 'check', NAME, '--webhook', `${baseUrl}/hook`]);

    expect(status).toBe(0);
    expect(stdout).toContain('WARNING');
    expect(requests).toHaveLength(0);
  });

  it('does not send when there are no findings', async () => {
    await seed([20, 20, 20]);

    const { status } = await runCli(['snapshot', 'check', NAME, '--webhook', `${baseUrl}/hook`]);

    expect(status).toBe(0);
    expect(requests).toHaveLength(0);
  });
});
