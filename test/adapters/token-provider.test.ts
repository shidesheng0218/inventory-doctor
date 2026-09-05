import { describe, expect, it, vi } from 'vitest';
import {
  ClientCredentialsProvider,
  StaticTokenProvider,
  tokenProviderFor,
} from '../../src/adapters/shopify-api/token-provider.js';

function tokenResponse(token: string, expiresIn = 86_399): Response {
  return new Response(JSON.stringify({ access_token: token, scope: 'read_inventory', expires_in: expiresIn }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('StaticTokenProvider', () => {
  it('always returns the same shpat_ token without any network call', async () => {
    const p = new StaticTokenProvider('shpat_abc');
    expect(await p.getToken()).toBe('shpat_abc');
    expect(await p.getToken()).toBe('shpat_abc');
  });
});

describe('ClientCredentialsProvider', () => {
  it('posts client_credentials grant to the SHOP domain without a scope param', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse('tok-1'));
    const p = new ClientCredentialsProvider({
      domain: 'a.myshopify.com',
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn,
    });
    expect(await p.getToken()).toBe('tok-1');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://a.myshopify.com/admin/oauth/access_token');
    const body = String(init.body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=id');
    expect(body).not.toContain('scope=');
  });

  it('caches the token for its 24h lifetime and refreshes 60s early', async () => {
    let now = 1_000_000;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse('tok-1', 86_399))
      .mockResolvedValueOnce(tokenResponse('tok-2', 86_399));
    const p = new ClientCredentialsProvider({
      domain: 'a.myshopify.com',
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn,
      now: () => now,
    });

    expect(await p.getToken()).toBe('tok-1');
    // 1 hour later: still cached, no second request.
    now += 3_600_000;
    expect(await p.getToken()).toBe('tok-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // 30s before expiry (inside the 60s margin): refreshes.
    now = 1_000_000 + 86_399_000 - 30_000;
    expect(await p.getToken()).toBe('tok-2');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent refreshes into one request', async () => {
    let resolveIt: (r: Response) => void = () => {};
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((res) => {
          resolveIt = res;
        }),
    );
    const p = new ClientCredentialsProvider({
      domain: 'a.myshopify.com',
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn,
    });
    const [t1, t2] = [p.getToken(), p.getToken()];
    resolveIt(tokenResponse('tok-x'));
    expect(await t1).toBe('tok-x');
    expect(await t2).toBe('tok-x');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive error on shop_not_permitted-style failures', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('shop_not_permitted', { status: 403 }));
    const p = new ClientCredentialsProvider({
      domain: 'a.myshopify.com',
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn,
    });
    await expect(p.getToken()).rejects.toThrow(/403.*same org/s);
  });
});

describe('tokenProviderFor', () => {
  it('prefers the static token when both modes are configured', () => {
    const p = tokenProviderFor({ domain: 'a.myshopify.com', accessToken: 'shpat_x', clientId: 'i', clientSecret: 's' });
    expect(p).toBeInstanceOf(StaticTokenProvider);
  });
  it('uses client credentials when no static token exists', () => {
    const p = tokenProviderFor({ domain: 'a.myshopify.com', clientId: 'i', clientSecret: 's' });
    expect(p).toBeInstanceOf(ClientCredentialsProvider);
  });
  it('rejects stores without credentials', () => {
    expect(() => tokenProviderFor({ domain: 'a.myshopify.com' })).toThrow();
  });
});
