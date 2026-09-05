import { describe, expect, it } from 'vitest';
import {
  fullWidthToHalfWidth,
  isPrefixSuffixVariant,
  longestCommonSubstringLength,
  normalizeSku,
  stripInvisible,
} from '../../src/core/normalize.js';

describe('normalizeSku', () => {
  it('trims whitespace and folds case', () => {
    expect(normalizeSku('  ABC-123 ').canonical).toBe('abc-123');
    expect(normalizeSku('  ABC-123 ').raw).toBe('  ABC-123 '); // raw preserved
  });

  it('converts full-width characters to half-width', () => {
    // ＡＢＣ－１２３ (full-width) → abc-123
    expect(normalizeSku('ＡＢＣ－１２３').canonical).toBe('abc-123');
    expect(fullWidthToHalfWidth('ＳＨＯＰ')).toBe('SHOP');
  });

  it('converts full-width space to normal space', () => {
    expect(normalizeSku('ABC　123').trimmed).toBe('ABC 123');
  });

  it('strips zero-width and invisible characters', () => {
    expect(stripInvisible('AB​C‑123')).toBe('ABC‑123');
    expect(normalizeSku('ABC​‑123').canonical).toBe('abc‑123');
  });

  it('keeps raw value untouched', () => {
    const n = normalizeSku(' Abc ');
    expect(n.raw).toBe(' Abc ');
    expect(n.trimmed).toBe('Abc');
    expect(n.canonical).toBe('abc');
  });
});

describe('longestCommonSubstringLength', () => {
  it('finds the shared core of prefix/suffix variants', () => {
    expect(longestCommonSubstringLength('abc-123', 'shop-abc-123')).toBe(7);
    expect(longestCommonSubstringLength('', 'x')).toBe(0);
  });
});

describe('isPrefixSuffixVariant', () => {
  it('detects containment', () => {
    expect(isPrefixSuffixVariant('abc-123', 'shop-abc-123')).toBe(true);
    expect(isPrefixSuffixVariant('abc-123', 'abc-124')).toBe(false);
  });
});
