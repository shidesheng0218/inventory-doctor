import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  readOAuthToken,
  runOAuthFlow,
  saveOAuthToken,
} from '../../src/adapters/shopify-api/oauth.js';
import { OAuthTokenProvider, tokenProviderFor } from '../../src/adapters/shopify-api/token-provider.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'invdoc-oauth-'));
  process.env['INVENTORY_DOCTOR_OAUTH_TOKEN_FILE'] = join(dir, 'oauth-tokens.json');
});

afterEach(async () => {
  delete process.env['INVENTORY_DOCTOR_OAUTH_TOKEN_FILE'];
  await rm(dir, { recursive: true, force: true });
});

describe('buildAuthorizeUrl', () => {
  it('hits the shop domain with read-only scopes and state', () => {
    const url = buildAuthorizeUrl({
      domain: 'client.myshopify.com',
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:9999/callback',
      state: 'abc123',
      scopes: ['read_inventory', 'read_products', 'read_locations'],
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://client.myshopify.com');
    expect(parsed.pathname).toBe('/admin/oauth/authorize');
    expect(parsed.searchParams.get('scope')).toBe('read_inventory,read_products,read_locations');
    expect(parsed.searchParams.get('state')).toBe('abc123');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:9999/callback');
  });
});

describe('token file', () => {
  it('saves with 0600 permissions and reads back', async () => {
    const path = await saveOAuthToken('a.myshopify.com', 'shp-token', 'read_inventory');
    expect(await readOAuthToken('a.myshopify.com')).toBe('shp-token');
    expect(await readOAuthToken('other.myshopify.com')).toBeNull();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('OAuthTokenProvider reads the saved token and errors with guidance otherwise', async () => {
    await saveOAuthToken('a.myshopify.com', 'shp-token', 'read_inventory');
    await expect(new OAuthTokenProvider('a.myshopify.com').getToken()).resolves.toBe('shp-token');
    await expect(new OAuthTokenProvider('missing.myshopify.com').getToken()).rejects.toThrow(/inventory-doctor auth/);
  });

  it('tokenProviderFor selects oauth mode', () => {
    const provider = tokenProviderFor({ domain: 'a.myshopify.com', oauth: true });
    expect(provider).toBeInstanceOf(OAuthTokenProvider);
  });
});

describe('exchangeCodeForToken', () => {
  it('posts the code and returns the offline token', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ access_token: 'tok', scope: 'read_inventory' }), { status: 200 }));
    const result = await exchangeCodeForToken('a.myshopify.com', 'cid', 'secret', 'code-123', fetchFn);
    expect(result.token).toBe('tok');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://a.myshopify.com/admin/oauth/access_token');
    expect(String(init.body)).toContain('code=code-123');
  });
});

describe('runOAuthFlow (loopback integration)', () => {
  it('completes the full flow: server up → callback with state → token saved', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ access_token: 'offline-tok', scope: 'read_inventory' }), { status: 200 }));

    const flow = runOAuthFlow({
      domain: 'client.myshopify.com',
      clientId: 'cid',
      clientSecret: 'secret',
      fetchFn,
      presentUrl: (url) => {
        // Simulate the merchant's browser: follow the redirect back to loopback.
        const redirectUri = new URL(url).searchParams.get('redirect_uri') as string;
        const state = new URL(url).searchParams.get('state') as string;
        void fetch(`${redirectUri}?code=test-code&state=${state}`);
      },
    });

    const result = await flow;
    expect(result.token).toBe('offline-tok');
    expect(await readOAuthToken('client.myshopify.com')).toBe('offline-tok');
  });

  it('rejects on state mismatch (CSRF guard)', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const flow = runOAuthFlow({
      domain: 'client.myshopify.com',
      clientId: 'cid',
      clientSecret: 'secret',
      fetchFn,
      presentUrl: (url) => {
        const redirectUri = new URL(url).searchParams.get('redirect_uri') as string;
        void fetch(`${redirectUri}?code=test-code&state=WRONG`);
      },
    });
    await expect(flow).rejects.toThrow(/state mismatch/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
