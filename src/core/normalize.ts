// SKU normalization — used ONLY for comparison, never for output.
// Reports always show the raw SKU as it appeared in the source file.

// Zero-width and other invisible code points that sneak in via copy/paste:
// U+200B-U+200D (zero-width space/non-joiner/joiner), U+200E/U+200F (LRM/RLM),
// U+202A-U+202E (directional formatting), U+2060 (word joiner), U+FEFF (BOM).
const INVISIBLE_CHARS = /[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060\uFEFF]/g;

// Full-width ASCII block (！-~) → half-width, plus full-width space.
export function fullWidthToHalfWidth(input: string): string {
  return input
    .replace(/\u3000/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE_CHARS, '');
}

export interface NormalizedSku {
  raw: string;
  // Fully normalized: half-width, invisible-stripped, trimmed, case-folded.
  canonical: string;
  // Like canonical but case-preserving; used to detect "case-only" mismatches.
  trimmed: string;
}

export function normalizeSku(raw: string): NormalizedSku {
  const half = fullWidthToHalfWidth(raw);
  const cleaned = stripInvisible(half);
  const trimmed = cleaned.trim();
  return { raw, trimmed, canonical: trimmed.toLowerCase() };
}

export function canonicalSku(raw: string): string {
  return normalizeSku(raw).canonical;
}

// Longest common substring length — heuristic for prefix/suffix mismatches
// like "ABC-123" vs "SHOP-ABC-123".
export function longestCommonSubstringLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  // DP with rolling rows; a is the shorter string.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array<number>(short.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= long.length; i++) {
    const curr = new Array<number>(short.length + 1).fill(0);
    for (let j = 1; j <= short.length; j++) {
      if (long[i - 1] === short[j - 1]) {
        curr[j] = (prev[j - 1] ?? 0) + 1;
        if ((curr[j] ?? 0) > best) best = curr[j] ?? 0;
      }
    }
    prev = curr;
  }
  return best;
}

// True when one string is the other plus a prefix/suffix (heuristic:
// the shorter one is a substring of the longer one after normalization).
export function isPrefixSuffixVariant(shorter: string, longer: string): boolean {
  if (shorter.length === 0) return false;
  return longer.includes(shorter);
}
