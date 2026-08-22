import { InvalidAmountError } from './errors.js';

/**
 * Integer-only rupiah amount.
 *
 * SingaPay signatures hash the serialized request body, and a whole float
 * serializes differently across runtimes (`100000.0` versus `100000`), which
 * breaks signatures silently. This value object makes the invalid state
 * unrepresentable: an amount is always a whole, non-negative rupiah integer.
 *
 * ```ts
 * Amount.rupiah(150_000).value;   // 150000
 * Amount.from('150000').value;    // 150000
 * Amount.from('150000.50');       // throws InvalidAmountError
 * ```
 *
 * It serializes through `toJSON()` as a bare integer, so it can be dropped
 * straight into a request body.
 */
export class Amount {
  private constructor(readonly value: number) {}

  /**
   * Create an amount from whole rupiah.
   *
   * @throws {InvalidAmountError} When the value is negative or not a safe integer.
   */
  static rupiah(value: number): Amount {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidAmountError(
        `Amount must be a whole rupiah integer within the safe integer range, got ${value}.`,
      );
    }

    if (value < 0) {
      throw new InvalidAmountError(`Amount must not be negative, got ${value}.`);
    }

    return new Amount(value);
  }

  /**
   * Create an amount from a number, a plain decimal string, or another Amount.
   *
   * Only plain decimal strings are accepted: digits with an optional all-zero
   * fraction (`"100000"`, `"100000.00"`). Fractional values, exponent notation
   * (`"1e3"`) and signs (`"+100"`) are rejected — anything ambiguous has no
   * place in a signed payment payload.
   *
   * @throws {InvalidAmountError} When the value is fractional, malformed, negative, or too large.
   */
  static from(value: number | string | Amount): Amount {
    if (value instanceof Amount) {
      return value;
    }

    if (typeof value === 'number') {
      return Amount.rupiah(value);
    }

    const matched = /^(\d+)(?:\.(\d+))?$/.exec(value);

    if (matched === null) {
      throw new InvalidAmountError(
        `Amount must be a plain decimal integer string, got "${value}".`,
      );
    }

    const fraction = matched[2];

    if (fraction !== undefined && fraction.replace(/0/g, '') !== '') {
      throw new InvalidAmountError(`Amount must not have a fractional part, got "${value}".`);
    }

    const whole = (matched[1] as string).replace(/^0+/, '');

    if (whole === '') {
      return Amount.rupiah(0);
    }

    const parsed = Number(whole);

    if (!Number.isSafeInteger(parsed)) {
      throw new InvalidAmountError(
        `Amount exceeds the safe integer range and would lose precision, got "${value}".`,
      );
    }

    return Amount.rupiah(parsed);
  }

  /** Serialize as a bare integer, the only representation SingaPay accepts. */
  toJSON(): number {
    return this.value;
  }

  /** Human-readable Indonesian format, e.g. `Rp150.000`. */
  format(): string {
    return `Rp${this.value.toLocaleString('id-ID')}`;
  }

  toString(): string {
    return String(this.value);
  }
}
