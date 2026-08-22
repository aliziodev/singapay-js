/**
 * Centralized clock for every time value the SingaPay API consumes.
 *
 * SingaPay mixes several representations: the access-token signature uses a
 * YYYYMMDD date in Asia/Jakarta, `X-Timestamp` headers use Unix seconds, and
 * some filters use 13-digit Unix milliseconds. Funneling every conversion
 * through one class keeps those rules in a single tested place.
 */
export class JakartaClock {
  /**
   * WIB is UTC+7 year round and has never observed daylight saving, so a
   * fixed offset is exact — no timezone database needed, and the same result
   * on every runtime.
   */
  static readonly OFFSET_MS = 7 * 60 * 60 * 1000;

  /**
   * @param source Injected in tests to freeze time. Defaults to the system clock.
   */
  constructor(private readonly source: () => Date = () => new Date()) {}

  now(): Date {
    return this.source();
  }

  /**
   * Current date as the YYYYMMDD string used by the access-token signature.
   *
   * The signature is only valid for the current Jakarta calendar day. Between
   * 00:00 and 07:00 WIB a UTC-based date is one day behind and the gateway
   * rejects the signature — the bug the official Node.js example ships with.
   */
  signatureDate(): string {
    const jakarta = new Date(this.now().getTime() + JakartaClock.OFFSET_MS);
    const month = String(jakarta.getUTCMonth() + 1).padStart(2, '0');
    const day = String(jakarta.getUTCDate()).padStart(2, '0');

    return `${jakarta.getUTCFullYear()}${month}${day}`;
  }

  /** Current Unix timestamp in seconds, as sent in the `X-Timestamp` header. */
  unixSeconds(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  /** Current Unix timestamp in milliseconds (13 digits). */
  unixMilliseconds(): number {
    return this.now().getTime();
  }

  /** Convert a date to the 13-digit millisecond format some filters expect. */
  toMilliseconds(date: Date): number {
    return date.getTime();
  }
}
