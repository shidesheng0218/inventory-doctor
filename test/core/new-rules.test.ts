import { describe, expect, it } from 'vitest';
import { quantityBasisMismatch } from '../../src/core/rules/quantity-basis-mismatch.js';
import { locationOrphan } from '../../src/core/rules/location-orphan.js';
import { rec } from '../helpers.js';

describe('quantity-basis-mismatch', () => {
  it('warns when comparing available vs inventory basis', () => {
    const records = [
      rec({ source: 'a', sku: 'X', quantity: 10, quantityBasis: 'available' }),
      rec({ source: 'b', sku: 'X', quantity: 10, quantityBasis: 'inventory' }),
    ];
    const findings = quantityBasisMismatch(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.message).toContain('available');
    expect(findings[0]?.message).toContain('inventory');
  });

  it('reports info when both bases are unknown', () => {
    const records = [
      rec({ source: 'a', sku: 'Y', quantity: 5, quantityBasis: 'unknown' }),
      rec({ source: 'b', sku: 'Y', quantity: 5, quantityBasis: undefined }),
    ];
    const findings = quantityBasisMismatch(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.message).toContain('unknown');
  });

  it('does not report when both bases are the same and known', () => {
    const records = [
      rec({ source: 'a', sku: 'Z', quantity: 7, quantityBasis: 'available' }),
      rec({ source: 'b', sku: 'Z', quantity: 7, quantityBasis: 'available' }),
    ];
    const findings = quantityBasisMismatch(records);
    expect(findings).toHaveLength(0);
  });

  it('does not report when SKU is only in one source', () => {
    const records = [
      rec({ source: 'a', sku: 'ORPHAN', quantity: 3, quantityBasis: 'available' }),
    ];
    const findings = quantityBasisMismatch(records);
    expect(findings).toHaveLength(0);
  });

  it('does not report when both sides have null quantities', () => {
    const records = [
      rec({ source: 'a', sku: 'NULL', quantity: null, quantityBasis: 'available' }),
      rec({ source: 'b', sku: 'NULL', quantity: null, quantityBasis: 'inventory' }),
    ];
    const findings = quantityBasisMismatch(records);
    expect(findings).toHaveLength(0);
  });
});

describe('location-orphan', () => {
  it('warns when a location exists in one source but not the other', () => {
    const records = [
      rec({ source: 'a', sku: 'M-1', location: 'Warehouse A', quantity: 10 }),
      rec({ source: 'a', sku: 'M-1', location: 'Warehouse B', quantity: 5 }),
      rec({ source: 'b', sku: 'M-1', location: 'Warehouse A', quantity: 10 }),
      // Warehouse B missing in source b
    ];
    const findings = locationOrphan(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.sku).toBe('M-1');
    expect(findings[0]?.message).toContain('Warehouse B');
    expect(findings[0]?.detail).toMatchObject({ location: 'Warehouse B', presentIn: 'a', missingFrom: 'b' });
  });

  it('reports orphans in both directions', () => {
    const records = [
      rec({ source: 'a', sku: 'M-2', location: 'Loc-A', quantity: 3 }),
      rec({ source: 'b', sku: 'M-2', location: 'Loc-B', quantity: 4 }),
    ];
    const findings = locationOrphan(records);
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.message.includes('Loc-A'))).toBe(true);
    expect(findings.some((f) => f.message.includes('Loc-B'))).toBe(true);
  });

  it('does not report when both sources have the same locations', () => {
    const records = [
      rec({ source: 'a', sku: 'M-3', location: 'Main', quantity: 10 }),
      rec({ source: 'b', sku: 'M-3', location: 'Main', quantity: 10 }),
    ];
    const findings = locationOrphan(records);
    expect(findings).toHaveLength(0);
  });

  it('does not report when only one source has location dimension', () => {
    const records = [
      rec({ source: 'a', sku: 'M-4', location: 'Warehouse', quantity: 5 }),
      rec({ source: 'b', sku: 'M-4', location: null, quantity: 5 }),
    ];
    const findings = locationOrphan(records);
    expect(findings).toHaveLength(0);
  });

  it('does not report when SKU is absent from the other source', () => {
    const records = [
      rec({ source: 'a', sku: 'ORPHAN-SKU', location: 'Main', quantity: 2 }),
    ];
    const findings = locationOrphan(records);
    expect(findings).toHaveLength(0);
  });
});
