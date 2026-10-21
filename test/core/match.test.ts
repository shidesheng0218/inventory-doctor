import { describe, expect, it } from 'vitest';
import { perLocationQuantities } from '../../src/core/match.js';
import { rec } from '../helpers.js';

describe('perLocationQuantities', () => {
  it('keeps a null location distinct from a location literally named "(no location)"', () => {
    const bucket = {
      canonical: 'x',
      records: [
        rec({ source: 'a', sku: 'X', location: null, quantity: 1 }),
        rec({ source: 'a', sku: 'X', location: '(no location)', quantity: 2 }),
      ],
    };
    const map = perLocationQuantities(bucket);
    expect(map.size).toBe(2);
    expect(map.get(null)?.quantity).toBe(1);
    expect(map.get('(no location)')?.quantity).toBe(2);
  });
});
