/**
 * Every error this SDK throws derives from {@link SingaPayError}, so a caller
 * can catch the whole family with a single `instanceof` check.
 */
export class SingaPayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when the SDK is configured with missing or invalid values. */
export class ConfigurationError extends SingaPayError {}

/**
 * Thrown when a request body cannot be canonicalized for signing — a float, an
 * unsupported type, or a value JSON cannot represent.
 */
export class JsonNormalizationError extends SingaPayError {}

/** Thrown when an amount is not a whole, non-negative rupiah integer. */
export class InvalidAmountError extends SingaPayError {}

/** Thrown when SingaPay rejects the credentials during the token exchange. */
export class AuthenticationError extends SingaPayError {}

/** Thrown when the gateway cannot be reached at all (DNS, TLS, timeout). */
export class ConnectionError extends SingaPayError {}

/**
 * Thrown when a money-out call is attempted while the money-out guard is off.
 *
 * The guard defaults to disabled so a misconfigured environment can never move
 * real funds by accident.
 */
export class MoneyOutDisabledError extends SingaPayError {
  constructor(readonly operation: string) {
    super(
      `Money-out is disabled: ${operation}. Set moneyOut.enabled to true on environments that may transfer funds.`,
    );
  }
}

/** Thrown when an inbound webhook fails verification. */
export class WebhookVerificationError extends SingaPayError {}

/** Thrown when this package is loaded into a browser bundle. */
export class BrowserUsageError extends SingaPayError {}

/** Everything known about a failed gateway response. */
export type ApiErrorContext = {
  /** HTTP status code. */
  status: number;
  /** SP response code, when the envelope carried one. */
  code: string | null;
  /** Human-readable gateway message. */
  message: string;
  /** The complete decoded response body, untouched. */
  raw: unknown;
};

/** Thrown when the gateway answers with a failure envelope. */
export class ApiError extends SingaPayError {
  readonly status: number;
  readonly code: string | null;
  readonly raw: unknown;

  constructor(context: ApiErrorContext) {
    const code = context.code === null ? '' : ` ${context.code}`;

    super(`SingaPay request failed [HTTP ${context.status}${code}]: ${context.message}`);

    this.status = context.status;
    this.code = context.code;
    this.raw = context.raw;
  }
}

/**
 * SP017 — this server IP address is not whitelisted in the SingaPay dashboard.
 *
 * Broken out from {@link ApiError} because the cause and the fix are entirely
 * different from a normal rejection, and because it is by far the most common
 * failure when deploying to a platform with dynamic egress IPs (Vercel,
 * Netlify, Cloudflare Workers), which cannot be whitelisted at all.
 */
export class IpNotWhitelistedError extends ApiError {}

/** SP003 — the merchant balance cannot cover the transaction. */
export class InsufficientBalanceError extends ApiError {}

/** SP004 — the reference number has already been used. */
export class DuplicateReferenceError extends ApiError {}

/** SP403 — the call must use the credential that owns the account. */
export class AccountCredentialRequiredError extends ApiError {}

/**
 * SP001 / SP005 — the outcome is genuinely unknown.
 *
 * Never retry blindly after this: call the matching `inquireStatus()` with the
 * same reference number first. A blind retry can duplicate a real transfer.
 */
export class IndeterminateOutcomeError extends ApiError {}
