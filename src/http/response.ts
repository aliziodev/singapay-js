import {
  AccountCredentialRequiredError,
  ApiError,
  DuplicateReferenceError,
  IndeterminateOutcomeError,
  InsufficientBalanceError,
  IpNotWhitelistedError,
} from '../errors.js';
import { ResponseCode } from '../response-code.js';

/**
 * A gateway response, folded into one shape.
 *
 * SingaPay answers with several envelope generations depending on the API
 * version:
 *
 * - v1: `{"status": 200, "success": true, "data": {...}}`, errors under
 *   `{"error": {"code", "message"}}`
 * - v2: `{"response_code": "SP000", "response_message": "...", "data": {...}}`
 * - flat: token exchanges return the payload with no envelope at all
 *
 * Calling code never has to know which generation an endpoint belongs to.
 */
export interface SingaPayResponse {
  /** HTTP status code. */
  status: number;
  /** SP response code, when the envelope carried one. */
  code: string | null;
  /** Human-readable gateway message. */
  message: string;
  /**
   * The `data` portion of the envelope, or the whole payload when flat.
   *
   * Always an object. When the gateway returned a list — which every `list()`
   * style endpoint does — this is empty and the rows are in {@link items}.
   */
  data: Record<string, unknown>;
  /**
   * The rows, when the gateway returned a list, and `null` otherwise.
   *
   * Kept separate from {@link data} rather than widening it to a union, so a
   * single-record read like `response.data.payment_url` stays as it is. Read
   * this for anything that lists.
   */
  items: unknown[] | null;
  /** The complete decoded body, untouched. */
  raw: unknown;
  /** Whether the gateway reported success. */
  successful: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Normalize a decoded response body into {@link SingaPayResponse}. */
export function parseEnvelope(status: number, raw: unknown): SingaPayResponse {
  const body = asRecord(raw);

  if (body === null) {
    return {
      status,
      code: null,
      message: '',
      data: {},
      // A flat payload that is itself a list still has rows worth returning.
      items: Array.isArray(raw) ? raw : null,
      raw,
      successful: status >= 200 && status < 300,
    };
  }

  const error = asRecord(body.error);
  const code = asString(body.response_code) ?? asString(error?.code);
  const message =
    asString(body.response_message) ?? asString(error?.message) ?? asString(body.message) ?? '';

  // `asRecord` rejects arrays deliberately, which is right for `body` and
  // `error` but would silently drop every list payload here. The rows go to
  // `items` instead of being thrown away.
  const items = Array.isArray(body.data) ? body.data : null;
  const data = asRecord(body.data) ?? (body.data === undefined ? body : {});

  let successful: boolean;

  if (code !== null) {
    successful = code === ResponseCode.Success;
  } else if (typeof body.success === 'boolean') {
    successful = body.success;
  } else {
    successful = status >= 200 && status < 300 && error === null;
  }

  return { status, code, message, data, items, raw, successful };
}

/**
 * Does this failure mean the caller's IP is not whitelisted?
 *
 * The gateway says so in two different ways. The documented one is `SP017`.
 * The access-token host instead answers HTTP 403 with a plain sentence and an
 * `error.code` holding the HTTP status — a number, which {@link parseEnvelope}
 * drops on purpose because an HTTP status is not an SP code.
 *
 * The undocumented shape is the one a real deployment meets first: a server
 * whose IP is not registered never gets past the token exchange, so it never
 * reaches an endpoint that could answer `SP017` at all. Matching only the code
 * left that case falling through to {@link AuthenticationError}, sending
 * people to audit credentials that were never wrong.
 *
 * The message test is deliberately narrow. The other HTTP 403 the gateway
 * returns — `Access denied to this account.` — must stay an
 * {@link AccountCredentialRequiredError}, and it says nothing about an IP.
 */
export function isIpRejection(response: SingaPayResponse): boolean {
  if (response.code === ResponseCode.UnauthorizedIp) {
    return true;
  }

  if (response.status !== 403) {
    return false;
  }

  const message = response.message.toLowerCase();

  return message.includes('ip address') && message.includes('not registered');
}

/**
 * Map a failed response onto the most specific error class available.
 *
 * The specific classes exist for the codes a caller actually branches on:
 * a non-whitelisted IP needs a deployment change, an indeterminate outcome
 * needs a status inquiry rather than a retry.
 */
export function toApiError(response: SingaPayResponse): ApiError {
  const context = {
    status: response.status,
    code: response.code,
    message: response.message,
    raw: response.raw,
  };

  // Checked ahead of the switch because the shape that matters most carries
  // no code to switch on.
  if (isIpRejection(response)) {
    return new IpNotWhitelistedError(context);
  }

  switch (response.code) {
    case ResponseCode.InsufficientBalance:
      return new InsufficientBalanceError(context);
    case ResponseCode.DuplicateReferenceNumber:
      return new DuplicateReferenceError(context);
    case ResponseCode.AccountCredentialRequired:
      return new AccountCredentialRequiredError(context);
    case ResponseCode.TransactionFailure:
    case ResponseCode.Timeout:
      return new IndeterminateOutcomeError(context);
    default:
      return new ApiError(context);
  }
}
