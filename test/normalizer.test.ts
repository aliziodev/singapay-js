import { describe, expect, it } from 'vitest';
import { Amount } from '../src/amount.js';
import { JsonNormalizationError } from '../src/errors.js';
import { normalizeJson } from '../src/normalize/json-normalizer.js';

describe('normalizeJson', () => {
  it('rejects a float, whole or otherwise', () => {
    expect(() => normalizeJson({ amount: 100_000.5 })).toThrow(JsonNormalizationError);
    expect(() => normalizeJson({ amount: 1e21 })).toThrow(JsonNormalizationError);
  });

  it('keeps integer-like keys in byte order rather than numeric order', () => {
    // A JavaScript object enumerates "2" and "10" numerically, ahead of "a".
    // PHP sorts them as strings. The output is assembled by hand precisely so
    // this case does not silently produce a different signature.
    expect(normalizeJson({ '10': 'ten', '2': 'two', a: 'letter' })).toBe(
      '{"10":"ten","2":"two","a":"letter"}',
    );
  });

  it('preserves array order while sorting keys inside elements', () => {
    expect(
      normalizeJson({
        items: [
          { b: 1, a: 2 },
          { d: 3, c: 4 },
        ],
      }),
    ).toBe('{"items":[{"a":2,"b":1},{"c":4,"d":3}]}');
  });

  it('drops keys whose value is undefined, so body and signature agree', () => {
    expect(normalizeJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('rejects undefined inside an array, which would silently become null', () => {
    expect(() => normalizeJson({ items: [1, undefined] })).toThrow(JsonNormalizationError);
  });

  it('leaves slashes and non-ASCII unescaped', () => {
    expect(normalizeJson({ url: 'https://gonsu.id/thanks', name: 'Ayu Wulandari' })).toBe(
      '{"name":"Ayu Wulandari","url":"https://gonsu.id/thanks"}',
    );
  });

  it('serializes an Amount through toJSON as a bare integer', () => {
    expect(normalizeJson({ total_amount: Amount.rupiah(150_000) })).toBe('{"total_amount":150000}');
  });

  it('rejects a value that cannot be signed unambiguously', () => {
    expect(() => normalizeJson({ set: new Set([1]) })).toThrow(JsonNormalizationError);
    expect(() => normalizeJson({ big: 10n })).toThrow(JsonNormalizationError);
  });

  it('distinguishes an empty object from an empty array', () => {
    expect(normalizeJson({ meta: {}, items: [] })).toBe('{"items":[],"meta":{}}');
  });
});
