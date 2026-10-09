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
      throw new Error(`webhook POST failed with HTTP ${response.status}`);
    }
  } catch (err) {
    // The webhook URL is often itself the bearer secret (Slack incoming
    // webhooks), so it must never surface in an error message that the CLI
    // prints to stderr.
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('webhook POST failed')) throw err;
    const safe = message.split(url).join('[redacted]');
    const name = err instanceof Error ? err.name : 'Error';
    throw new Error(`webhook POST failed: ${name}: ${safe}`);
  } finally {
    clearTimeout(timer);
  }
}
