export interface WebhookPayload {
  name: string;
  critical: number;
  warning: number;
  findings: Array<{ severity: string; message: string }>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// POST a JSON alert. Any failure — network error, abort, non-2xx — throws to
// the caller; the CLI layer decides how loudly to complain (stderr warning,
// never a changed exit code).
export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`webhook POST to ${url} failed with HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
