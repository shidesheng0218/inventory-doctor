import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const action = readFileSync(join(root, 'action.yml'), 'utf8');
const runScript = action.match(/      run: \|\n([\s\S]*?)\n    - name: Upload report/)?.[1];
if (!runScript) throw new Error('Could not extract composite action run script');
const shell = runScript.split('\n').map((line) => line.replace(/^        /, '')).join('\n');

function runAction(input: Record<string, string>, exitStatus = 0, source?: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'action-smoke-')));
  try {
    const bin = join(dir, 'bin');
    const workspace = join(dir, 'workspace');
    mkdirSync(bin); mkdirSync(workspace);
    const calls = join(dir, 'calls');
    const marker = join(dir, 'injected');
    const runCwd = join(dir, 'run-cwd');
    const a = join(dir, 'a file.csv');
    const b = join(dir, 'b.csv');
    writeFileSync(a, 'sku,quantity\nA,1\n'); writeFileSync(b, 'sku,quantity\nA,2\n');
    const config = join(dir, 'inventory-doctor.json');
    writeFileSync(config, '{}');
    writeFileSync(join(bin, 'npx'), `#!/bin/bash\nprintf '%s\\0' "$@" > "$CALLS"\npwd > "$RUN_CWD"\nprintf report\nexit ${exitStatus}\n`);
    chmodSync(join(bin, 'npx'), 0o755);
    const result = spawnSync('bash', ['-c', shell], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTION_PATH: root, CALLS: calls, GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: join(dir, 'output'), RUN_CWD: runCwd,
        INPUT_SOURCE_A: source === 'snapshot:file' ? 'snapshot:a file.csv' : source ?? 'a file.csv', INPUT_SOURCE_B: b, INPUT_CONFIG: input['config'] ?? '',
        INPUT_FORMAT: input['format'] ?? 'terminal', INPUT_VERSION: input['version'] ?? '0.4.0',
        INPUT_EXTRA_ARGS: input['extra'] ?? '', INPUT_FAIL_ON_CRITICAL: input['fail'] ?? 'true',
      },
    });
    return {
      status: result.status,
      args: existsSync(calls) ? readFileSync(calls, 'utf8').split('\0').filter(Boolean) : [],
      injected: existsSync(marker), cleaned: existsSync(runCwd) && !existsSync(readFileSync(runCwd, 'utf8').trim()),
      a, config,
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('action run-step contract', () => {
  it('executes the actual action script with defaults and argv-safe whitespace', () => {
    const result = runAction({ extra: '["--map","sku=Product SKU"]' });
    expect(result.status).toBe(0);
    expect(result.args).toContain('inventory-doctor@0.4.0');
    expect(result.args).toContain('--config');
    expect(result.args).toContain('sku=Product SKU');
    expect(result.args).toContain(result.a);
    expect(result.args).toContain(result.config);
    expect(result.cleaned).toBe(true);
  });

  it('rejects shell substitution and write-file options', () => {
    expect(runAction({ extra: '--map sku=$(touch injected)' })).toMatchObject({ status: 2, injected: false });
    expect(runAction({ extra: '--fix-export out.csv' }).status).toBe(2);
    expect(runAction({ extra: '--force' }).status).toBe(2);
    expect(runAction({ extra: '["--map","sku=$(touch injected)"]' })).toMatchObject({ status: 0, injected: false });
    expect(runAction({ extra: '--drift-abs 3 --drift-pct=0.2 --map sku=SKU' }).status).toBe(0);
  });

  it('absolutizes snapshot file refs while preserving the snapshot prefix', () => {
    const result = runAction({}, 0, 'snapshot:file');
    expect(result.args).toContain(`snapshot:${result.a}`);
    for (const ref of ['store:main', 'woo:shop', 'snapshot:main@id']) {
      expect(runAction({}, 0, ref).args).toContain(ref);
    }
  });

  it('honors critical exit policy and validates format and version', () => {
    expect(runAction({ fail: 'true' }, 1).status).toBe(1);
    expect(runAction({ fail: 'false' }, 1).status).toBe(0);
    expect(runAction({ fail: 'false' }, 2).status).toBe(2);
    expect(runAction({ fail: 'yes' }).status).toBe(2);
    expect(runAction({ format: 'invalid' }).status).toBe(2);
    expect(runAction({ version: 'latest;touch x' }).status).toBe(2);
  });
});
