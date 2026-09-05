import type { TokenProvider } from './token-provider.js';

// Shopify GraphQL Admin API client.
//   - API version is pinned explicitly in the URL: 2026-07 (latest stable).
//   - Throttling is ADAPTIVE: read extensions.cost.throttleStatus from every
//     response and slow down before the bucket empties. Bucket sizes per plan
//     are undocumented, so no rate numbers are hardcoded here.
//   - On HTTP 429 or a THROTTLED GraphQL error: back off 1s and retry.

export const API_VERSION = '2026-07';
export const BACKOFF_MS = 1_000;
// Start waiting when fewer than this fraction of the bucket remains.
const LOW_BUDGET_FRACTION = 0.1;
const MAX_RETRIES = 5;

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GraphqlCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ThrottleStatus;
}

export interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: GraphqlCost };
}

export interface ShopifyClientOptions {
  domain: string;
  tokenProvider: TokenProvider;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ShopifyClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly options: ShopifyClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
  }

  get endpoint(): string {
    return `https://${this.options.domain}/admin/api/${API_VERSION}/graphql.json`;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const token = await this.options.tokenProvider.getToken();
      const res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 429) {
        lastError = new Error(`Rate limited (HTTP 429) by ${this.options.domain}`);
        await this.sleep(BACKOFF_MS);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Shopify API HTTP ${res.status} from ${this.options.domain}: ${text}`);
      }

      const payload = (await res.json()) as GraphqlResponse<T>;

      const throttled = payload.errors?.some(
        (e) => e.extensions?.code === 'THROTTLED' || /throttled/i.test(e.message),
      );
      if (throttled) {
        lastError = new Error(`Rate limited (THROTTLED) by ${this.options.domain}`);
        await this.sleep(BACKOFF_MS);
        continue;
      }
      if (payload.errors && payload.errors.length > 0) {
        throw new Error(`Shopify GraphQL errors: ${payload.errors.map((e) => e.message).join('; ')}`);
      }
      if (payload.data === undefined) {
        throw new Error('Shopify GraphQL response had no data field.');
      }

      // Adaptive throttle: if the bucket is running low, pause long enough for
      // restoreRate to top it back up instead of slamming into THROTTLED.
      const status = payload.extensions?.cost?.throttleStatus;
      if (status && status.maximumAvailable > 0) {
        const fraction = status.currentlyAvailable / status.maximumAvailable;
        if (fraction < LOW_BUDGET_FRACTION && status.restoreRate > 0) {
          const needed = status.maximumAvailable * LOW_BUDGET_FRACTION - status.currentlyAvailable;
          await this.sleep(Math.ceil((needed / status.restoreRate) * 1000));
        }
      }

      return payload.data;
    }

    throw lastError ?? new Error(`Shopify API request failed after ${this.maxRetries} retries.`);
  }
}
