import { describe, expect, it } from 'vitest';
import { Amount } from '../src/amount.js';
import { InvalidAmountError } from '../src/errors.js';

describe('Amount', () => {
  it('accepts whole rupiah', () => {
    expect(Amount.rupiah(150_000).value).toBe(150_000);
    expect(Amount.from('150000').value).toBe(150_000);
    expect(Amount.from('150000.00').value).toBe(150_000);
    expect(Amount.from('0').value).toBe(0);
    expect(Amount.from('000150').value).toBe(150);
  });

  it('rejects anything fractional, signed, or exponential', () => {
    expect(() => Amount.from('150000.50')).toThrow(InvalidAmountError);
    expect(() => Amount.rupiah(150_000.5)).toThrow(InvalidAmountError);
    expect(() => Amount.from('1e3')).toThrow(InvalidAmountError);
    expect(() => Amount.from('+100')).toThrow(InvalidAmountError);
    expect(() => Amount.from('-100')).toThrow(InvalidAmountError);
    expect(() => Amount.rupiah(-1)).toThrow(InvalidAmountError);
  });

  it('rejects values that would lose precision', () => {
    expect(() => Amount.from('9007199254740993')).toThrow(InvalidAmountError);
  });

  it('serializes as a bare integer', () => {
    expect(JSON.stringify({ total: Amount.rupiah(150_000) })).toBe('{"total":150000}');
  });

  it('formats for humans', () => {
    expect(Amount.rupiah(150_000).format()).toBe('Rp150.000');
  });
});
