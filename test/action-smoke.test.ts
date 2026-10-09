import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

// Contract test for the composite action's run step: the command shape
// action.yml executes (default `terminal` format, the action's default too).
// The fixtures intentionally contain critical findings, so exit code 1 is the
// expected signal here. Markdown output is not asserted: its heading is
// "## Critical (8)" with no literal "CRITICAL" token.
describe('action run-step contract', () => {
  it('diff exits 1 with CRITICAL on stdout (default terminal format)', () => {
    let stdout = '';
    let status: number | null = null;
    try {
      stdout = execFileSync(
        'npx',
        ['tsx', 'src/cli.ts', 'diff', 'fixtures/shopify-store-a.csv', 'fixtures/shopify-store-b.csv'],
        { encoding: 'utf8' },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? null;
      stdout = typeof e.stdout === 'string' ? e.stdout : '';
    }
    expect(status).toBe(1);
    expect(stdout).toContain('CRITICAL');
  });
});
