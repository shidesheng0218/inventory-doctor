import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

// Shopify OAuth (authorization code grant) for the agency scenario: the app
// and store are NOT in the same org, so client credentials are rejected with
// shop_not_permitted. This module runs the browser flow locally:
//
//   inventory-doctor auth <domain> --client-id ... --client-secret ...
//
// starts a loopback callback server, sends the merchant through Shopify's
// consent screen, exchanges the code for an OFFLINE token (no expiry, no
// refresh logic needed), and stores it outside the project config file.

export const DEFAULT_SCOPES = ['read_inventory', 'read_products', 'read_locations'];

export function buildAuthorizeUrl(options: {
  domain: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    scope: options.scopes.join(','),
    redirect_uri: options.redirectUri,
    state: options.state,
    // No grant_options: the authorization code grant issues an OFFLINE token
    // by default — no expiry, no refresh flow to maintain.
  });
  return `https://${options.domain}/admin/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(
  domain: string,
  clientId: string,
  clientSecret: string,
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ token: string; scope: string }> {
  const res = await fetchFn(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth token exchange failed for ${domain}: HTTP ${res.status} ${text}`);
  }
  const data = (await res.json()) as { access_token?: string; scope?: string };
  if (!data.access_token) {
    throw new Error(`OAuth token response for ${domain} did not include access_token.`);
  }
  return { token: data.access_token, scope: data.scope ?? '' };
}

// --- token storage -------------------------------------------------------

interface TokenFile {
  tokens: Record<string, { token: string; scope: string; savedAt: string }>;
}

export function oauthTokenFilePath(): string {
  return process.env['INVENTORY_DOCTOR_OAUTH_TOKEN_FILE'] ?? join(homedir(), '.config', 'inventory-doctor', 'oauth-tokens.json');
}

export async function saveOAuthToken(domain: string, token: string, scope: string): Promise<string> {
  const path = oauthTokenFilePath();
  const file = await readTokenFile(path);
  file.tokens[domain] = { token, scope, savedAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return path;
}

export async function readOAuthToken(domain: string): Promise<string | null> {
  const file = await readTokenFile(oauthTokenFilePath());
  return file.tokens[domain]?.token ?? null;
}

async function readTokenFile(path: string): Promise<TokenFile> {
  if (!existsSync(path)) return { tokens: {} };
  return JSON.parse(await readFile(path, 'utf8')) as TokenFile;
}

// --- interactive flow ------------------------------------------------------

export interface OAuthFlowOptions {
  domain: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  fetchFn?: typeof fetch;
  // Injectable for tests: called with the authorize URL the user must visit.
  presentUrl?: (url: string) => void;
  timeoutMs?: number;
}

function defaultPresentUrl(url: string): void {
  process.stderr.write(`\nOpen this URL to authorize inventory-doctor:\n\n  ${url}\n\n`);
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // headless environment — the printed URL is enough
  }
}

export interface OAuthFlowResult {
  token: string;
  scope: string;
  tokenFilePath: string;
}

export async function runOAuthFlow(options: OAuthFlowOptions): Promise<OAuthFlowResult> {
  const state = randomBytes(16).toString('hex');
  const presentUrl = options.presentUrl ?? defaultPresentUrl;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const code = await waitForCallback(state, presentUrl, options, timeoutMs);
  const { token, scope } = await exchangeCodeForToken(
    options.domain,
    options.clientId,
    options.clientSecret,
    code,
    options.fetchFn ?? fetch,
  );
  const tokenFilePath = await saveOAuthToken(options.domain, token, scope);
  return { token, scope, tokenFilePath };
}

function waitForCallback(
  state: string,
  presentUrl: (url: string) => void,
  options: OAuthFlowOptions,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let server: Server | null = null;
    const timer = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth flow timed out waiting for the browser callback.'));
    }, timeoutMs);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400).end('state mismatch');
        clearTimeout(timer);
        server?.close();
        reject(new Error('OAuth callback state mismatch — possible CSRF, aborting.'));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400).end('missing code');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('inventory-doctor authorized. You can close this tab.');
      clearTimeout(timer);
      server?.close();
      resolve(code);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not start the loopback OAuth callback server.'));
        return;
      }
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      presentUrl(
        buildAuthorizeUrl({
          domain: options.domain,
          clientId: options.clientId,
          redirectUri,
          state,
          scopes: options.scopes ?? DEFAULT_SCOPES,
        }),
      );
    });
  });
}
