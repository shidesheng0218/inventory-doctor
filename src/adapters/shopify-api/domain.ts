const SHOPIFY_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+myshopify\.com$/i;

/** Validate and normalize a Shopify shop host before constructing any URL. */
export function validateShopifyDomain(domain: string): string {
  if (typeof domain !== 'string' || domain.length === 0 || domain.trim() !== domain) {
    throw new Error(`Invalid Shopify domain "${String(domain)}": expected a myshopify.com host without path, port, or userinfo.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${domain}`);
  } catch {
    throw new Error(`Invalid Shopify domain "${domain}": expected a myshopify.com host without path, port, or userinfo.`);
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.host.toLowerCase() !== domain.toLowerCase() ||
    domain.includes(':') ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !SHOPIFY_DOMAIN_RE.test(parsed.hostname)
  ) {
    throw new Error(`Invalid Shopify domain "${domain}": expected a myshopify.com host without path, port, or userinfo.`);
  }

  return parsed.hostname.toLowerCase();
}
