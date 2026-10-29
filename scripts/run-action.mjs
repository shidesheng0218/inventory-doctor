import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const env = process.env;
  const format = env.INPUT_FORMAT;
  if (!['terminal', 'json', 'markdown', 'html'].includes(format)) throw new Error('Invalid format');
  if (!['true', 'false'].includes(env.INPUT_FAIL_ON_CRITICAL)) throw new Error('fail-on-critical must be true or false');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(env.INPUT_VERSION ?? '')) throw new Error('version must be an exact npm version');
  function source(value) {
    if (!value || value.includes('\0') || value.startsWith('-')) throw new Error('Invalid source');
    if (value.startsWith('store:') || value.startsWith('woo:')) return value;
    if (value.startsWith('snapshot:')) {
      const ref = value.slice(9).trim();
      // Snapshot refs are either names (possibly @id), or literal .jsonl paths.
      return `snapshot:${existsSync(ref) || ref.endsWith('.jsonl') || /[/\\]/.test(ref) ? resolve(ref) : ref}`;
    }
    return resolve(value);
  }
  const args = ['diff', source(env.INPUT_SOURCE_A), source(env.INPUT_SOURCE_B), '--format', format];
  const config = env.INPUT_CONFIG;
  if (config) args.push('--config', resolve(config));
  else if (existsSync('inventory-doctor.json')) args.push('--config', resolve('inventory-doctor.json'));
  const raw = (env.INPUT_EXTRA_ARGS ?? '').trim();
  let extra = [];
  if (raw.startsWith('[')) {
    extra = JSON.parse(raw);
    if (!Array.isArray(extra) || extra.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('extra-args must be a JSON string array');
  } else if (raw) {
    if (/["'`\\$;|&<>\r\n]/.test(raw)) throw new Error('Unsupported extra-args syntax; use a JSON string array for literal values');
    extra = raw.split(/\s+/);
  }
  for (let i = 0; i < extra.length; i++) {
    const match = /^(--drift-abs|--drift-pct|--map)(?:=(.*))?$/s.exec(extra[i]);
    if (!match) throw new Error(`Unsupported diagnostic flag: ${extra[i]}`);
    const value = match[2] ?? extra[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${match[1]}`);
    if (match[1] === '--drift-abs' && !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid drift-abs');
    if (match[1] === '--drift-pct' && !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) throw new Error('Invalid drift-pct');
    if (match[1] === '--map' && !/^[^=]+=.+$/s.test(value)) throw new Error('Invalid map; expected field=header');
  }
  args.push(...extra);
  process.stdout.write(args.join('\0') + '\0');
} catch (error) {
  process.stderr.write(`Action input error: ${error.message}\n`);
  process.exitCode = 2;
}
