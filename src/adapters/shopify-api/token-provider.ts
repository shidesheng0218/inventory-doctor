// Dual-mode credential layer. Old "Develop apps" path can no longer create
// permanent tokens (since 2026-01-01) but existing shpat_ tokens still work;
// new apps use the client credentials grant against the SHOP domain.
// Both modes converge behind one TokenProvider interface.

export interface TokenProvider {
  getToken(): Promise<string>;
}

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
}

export interface ClientCredentialsOptions {
  domain: string; // shop domain, e.g. "my-store.myshopify.com"
  clientId: string;
  clientSecret: string;
  // Injectable for tests; defaults to global fetch.
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number; // when the token actually expires
}

// Tokens live 24h (expires_in ≈ 86399). Cache them and refresh REFRESH_MARGIN
// before expiry — never trade credentials for a token on every call.
const REFRESH_MARGIN_MS = 60_000;

export class ClientCredentialsProvider implements TokenProvider {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ClientCredentialsOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs - REFRESH_MARGIN_MS) {
      return this.cached.token;
    }
    // Collapse concurrent refreshes into one request.
    this.inflight ??= this.requestToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async requestToken(): Promise<string> {
    // Endpoint lives on the SHOP domain, not a central Shopify domain.
    // Do NOT send a scope parameter — the app's configured scopes apply.
    const url = `https://${this.options.domain}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Token request failed for ${this.options.domain}: HTTP ${res.status} ${text}. ` +
          'Note: client credentials require app and store in the same org (shop_not_permitted otherwise).',
      );
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new Error(`Token response for ${this.options.domain} did not include access_token.`);
    }
    const expiresInSec = data.expires_in ?? 86_399;
    this.cached = {
      token: data.access_token,
      expiresAtMs: this.now() + expiresInSec * 1000,
    };
    return data.access_token;
  }
}

export function tokenProviderFor(store: {
  domain: string;
  accessToken?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
}): TokenProvider {
  if (store.accessToken) {
    return new StaticTokenProvider(store.accessToken);
  }
  if (store.clientId && store.clientSecret) {
    return new ClientCredentialsProvider({
      domain: store.domain,
      clientId: store.clientId,
      clientSecret: store.clientSecret,
    });
  }
  throw new Error(`Store "${store.domain}": provide accessToken or clientId+clientSecret.`);
}
