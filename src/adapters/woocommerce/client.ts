// WooCommerce REST API (v3) client. Much simpler than Shopify's: consumer
// key/secret via HTTP Basic Auth, page-number pagination with the total in
// X-WP-TotalPages, and a 429 backoff. Requires HTTPS — Basic Auth over plain
// HTTP would leak credentials.

export const BACKOFF_MS = 1_000;
const MAX_RETRIES = 5;
const PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

export interface WooClientOptions {
  baseUrl: string; // e.g. "https://shop.example.com"
  consumerKey: string;
  consumerSecret: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number; // per-request timeout; a hung store must not hang the run
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WooClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly base: string;

  constructor(private readonly options: WooClientOptions) {
    if (!options.baseUrl.startsWith('https://')) {
      throw new Error(`WooCommerce baseUrl must start with https:// (got "${options.baseUrl}") — Basic Auth over plain HTTP leaks credentials.`);
    }
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.options.consumerKey}:${this.options.consumerSecret}`).toString('base64')}`;
  }

  // One page of a collection endpoint. Returns the body and totalPages.
  async getPage<T>(path: string, page: number): Promise<{ data: T[]; totalPages: number }> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this.base}/wp-json/wc/v3${path}${sep}per_page=${PER_PAGE}&page=${page}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { Authorization: this.authHeader },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // fetch() rejections are transient network failures — retry like 429.
        lastError =
          err instanceof Error && err.name === 'TimeoutError'
            ? new Error(`WooCommerce API request to ${this.base} timed out after ${this.timeoutMs}ms`)
            : new Error(
                `WooCommerce API request to ${this.base} failed: ${err instanceof Error ? err.message : String(err)}`,
              );
        await this.sleep(BACKOFF_MS);
        continue;
      }
      if (res.status === 429) {
        lastError = new Error(`Rate limited (HTTP 429) by ${this.base}`);
        await this.sleep(BACKOFF_MS);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`WooCommerce API HTTP ${res.status} from ${this.base}: ${text}`);
      }
      const header = res.headers.get('X-WP-TotalPages');
      const totalPages = header !== null && /^\d+$/.test(header) ? Number(header) : NaN;
      if (!Number.isSafeInteger(totalPages) || totalPages < 0) {
        throw new Error(`WooCommerce pagination for ${path} page ${page}: missing or invalid X-WP-TotalPages header`);
      }
      const data: unknown = await res.json();
      if (!Array.isArray(data)) {
        throw new Error(`WooCommerce pagination for ${path} page ${page}: expected an array response`);
      }
      if (totalPages === 0 && (page !== 1 || data.length !== 0)) {
        throw new Error(`WooCommerce pagination for ${path} page ${page}: zero total pages requires an empty first page`);
      }
      return { data: data as T[], totalPages };
    }

    throw lastError ?? new Error(`WooCommerce API request failed after ${this.maxRetries} retries.`);
  }

  // All pages of a collection endpoint, flattened.
  async getAll<T>(path: string): Promise<T[]> {
    const first = await this.getPage<T>(path, 1);
    if (first.data.length === 0 && first.totalPages > 1) {
      throw new Error(`WooCommerce pagination for ${path}: empty first page with ${first.totalPages} total pages`);
    }
    const out = [...first.data];
    for (let page = 2; page <= first.totalPages; page++) {
      const next = await this.getPage<T>(path, page);
      if (next.totalPages !== first.totalPages) {
        throw new Error(`WooCommerce pagination for ${path} page ${page}: total pages changed from ${first.totalPages} to ${next.totalPages}; retry with a stable catalog`);
      }
      if (next.data.length === 0) {
        throw new Error(`WooCommerce pagination for ${path} page ${page}: unexpected empty continuation page`);
      }
      out.push(...next.data);
    }
    return out;
  }
}
