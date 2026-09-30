// Public barrel for downstream apps (e.g. a hosted service embedding the
// engine): the Shopify adapter without going through the CLI/config path.
export { ShopifyClient } from './client.js';
export type { ShopifyClientOptions, GraphqlResponse, GraphqlCost, ThrottleStatus } from './client.js';
export { fetchInventory } from './fetch-inventory.js';
export { StaticTokenProvider, ClientCredentialsProvider, OAuthTokenProvider, tokenProviderFor } from './token-provider.js';
export type { TokenProvider } from './token-provider.js';
