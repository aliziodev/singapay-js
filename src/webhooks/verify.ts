import { RequestSigner } from '../auth/request-signer.js';
import { JakartaClock } from '../clock.js';
import { compareUtf8, sha256Hex, timingSafeEqualHex } from '../crypto.js';
import { WebhookVerificationError } from '../errors.js';
import type { WebhookTypeValue } from './types.js';
import { webhookTypeFromPayload } from './types.js';

/**
 * Header values a delivery carries. Pass a `Headers` instance, a Node-style
 * header record, or these three values directly.
 */
export type WebhookHeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | { signature?: string | null; timestamp?: string | null; authorization?: string | null };

export interface VerifyWebhookOptions {
  /** The raw request bytes, never a re-encoded parse. */
  rawBody: string;
  headers: WebhookHeaderSource;
  /**
   * The callback path exactly as configured in the SingaPay dashboard,
   * including any query string, e.g. `/api/webhooks/singapay`.
   */
  endpoint: string;
  /**
   * Candidate HMAC keys: the merchant client secret and/or the dashboard HMAC
   * Validation Key. The signature has to match one of them.
   */
  secrets: string | string[];
  /** Maximum accepted clock skew in seconds. Defaults to 300. */
  toleranceSeconds?: number;
  clock?: JakartaClock;
}

export interface VerifiedWebhook {
  /** The identified type, or `null` for a type this SDK does not know yet. */
  type: WebhookTypeValue | null;
  /** The decoded payload. */
  payload: Record<string, unknown>;
  /** The raw bytes, unchanged. */
  rawBody: string;
}

function headerValue(source: WebhookHeaderSource, name: string): string | null {
  if (typeof Headers !== 'undefined' && source instanceof Headers) {
    return source.get(name);
  }

  const record = source as Record<string, unknown>;
  const direct = record[name] ?? record[name.toLowerCase()];

  if (typeof direct === 'string') {
    return direct;
  }

  if (Array.isArray(direct) && typeof direct[0] === 'string') {
    return direct[0];
  }

  return null;
}

function resolveHeaders(source: WebhookHeaderSource): {
  signature: string | null;
  timestamp: string | null;
  authorization: string | null;
} {
  const shorthand = source as { signature?: string | null };

  if (typeof shorthand.signature === 'string') {
    const named = source as {
      signature?: string | null;
      timestamp?: string | null;
      authorization?: string | null;
    };

    return {
      signature: named.signature ?? null,
      timestamp: named.timestamp ?? null,
      authorization: named.authorization ?? null,
    };
  }

  return {
    signature: headerValue(source, 'X-Signature'),
    timestamp: headerValue(source, 'X-Timestamp'),
    authorization: headerValue(source, 'Authorization'),
  };
}

/**
 * Re-serialize a decoded webhook body the way the official PHP verification
 * sample does: recursive `ksort($array, SORT_STRING)` then `json_encode` with
 * unescaped unicode and slashes.
 *
 * Two PHP quirks are reproduced deliberately, because the gateway signs what
 * that sample produces:
 *
 * - `json_decode($body, true)` turns every object into a PHP array, so an
 *   empty object re-encodes as `[]`, not `{}`.
 * - An object whose keys are exactly `"0".."n-1"` re-encodes as a JSON array.
 *
 * Getting either wrong yields a different hash and a webhook that fails
 * verification for no visible reason.
 */
export function normalizeWebhookBody(value: unknown, depth = 0): string {
  // A genuine delivery nests a handful of levels. This body arrives from an
  // unauthenticated caller and is normalized *before* the signature is
  // checked, so without a ceiling a deep object exhausts the call stack and
  // raises a `RangeError` that escapes every documented error type.
  if (depth > MAX_WEBHOOK_DEPTH) {
    throw new WebhookVerificationError(
      `Webhook body nests deeper than ${MAX_WEBHOOK_DEPTH} levels. A genuine delivery never does.`,
    );
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => normalizeWebhookBody(item, depth + 1)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    compareUtf8(left, right),
  );

  if (entries.length === 0) {
    return '[]';
  }

  if (entries.every(([key], index) => key === String(index))) {
    return `[${entries.map(([, item]) => normalizeWebhookBody(item, depth + 1)).join(',')}]`;
  }

  const members = entries.map(
    ([key, item]) => `${JSON.stringify(key)}:${normalizeWebhookBody(item, depth + 1)}`,
  );

  return `{${members.join(',')}}`;
}

/**
 * How deep an inbound body may nest before it is rejected outright.
 *
 * Generous for real traffic — the deepest genuine delivery seen is four
 * levels — and far below the call-stack limit.
 */
const MAX_WEBHOOK_DEPTH = 64;

const signer = new RequestSigner();

/**
 * Verify an inbound SingaPay webhook.
 *
 * SingaPay signs webhooks with the same colon-separated scheme as money-out
 * requests:
 *
 * ```
 * string_to_sign = "POST:{ENDPOINT}:{ACCESS_TOKEN}:{hashed_body}:{TIMESTAMP}"
 * X-Signature    = HMAC-SHA512(string_to_sign, client_secret)
 * ```
 *
 * `ACCESS_TOKEN` comes from the inbound `Authorization` header — a token
 * SingaPay generated, not the merchant token. The body hash is tried against
 * the re-normalized form first (what the official samples produce) and then
 * against the raw bytes, so a gateway that signs the body verbatim still
 * verifies. Both comparisons are constant-time.
 *
 * @throws {WebhookVerificationError} When headers are missing, the timestamp is stale, or no signature matches.
 */
export async function verifyWebhook(options: VerifyWebhookOptions): Promise<VerifiedWebhook> {
  const { signature, timestamp, authorization } = resolveHeaders(options.headers);

  if (!signature || !timestamp || !authorization) {
    throw new WebhookVerificationError(
      'Webhook is missing one of the required headers: X-Signature, X-Timestamp, Authorization.',
    );
  }

  if (!/^\d+$/.test(timestamp)) {
    throw new WebhookVerificationError(
      `Webhook X-Timestamp is not a Unix timestamp: "${timestamp}".`,
    );
  }

  const tolerance = options.toleranceSeconds ?? 300;
  const clock = options.clock ?? new JakartaClock();
  const age = Math.abs(clock.unixSeconds() - Number(timestamp));

  if (age > tolerance) {
    throw new WebhookVerificationError(
      `Webhook timestamp is ${age}s off, outside the ${tolerance}s tolerance. Rejecting as a possible replay.`,
    );
  }

  let payload: unknown;

  try {
    payload = JSON.parse(options.rawBody) as unknown;
  } catch {
    // A bare `catch` on purpose: a hostile body can raise a `RangeError` from
    // the parser itself, not only a `SyntaxError`, and a caller handling
    // webhooks must never meet an error type this function does not document.
    throw new WebhookVerificationError('Webhook body could not be parsed as JSON.');
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new WebhookVerificationError('Webhook body is not a JSON object.');
  }

  const token = authorization.replace(/^Bearer\s+/i, '');
  const secrets = typeof options.secrets === 'string' ? [options.secrets] : options.secrets;

  if (secrets.length === 0) {
    throw new WebhookVerificationError('No webhook secret configured to verify against.');
  }

  const candidates = [
    await sha256Hex(normalizeWebhookBody(payload)),
    await sha256Hex(options.rawBody),
  ];

  const provided = signature.toLowerCase();

  for (const hashedBody of candidates) {
    for (const secret of secrets) {
      const expected = await signer.signHashedBody(
        'POST',
        options.endpoint,
        token,
        hashedBody,
        Number(timestamp),
        secret,
      );

      if (timingSafeEqualHex(expected, provided)) {
        return {
          type: webhookTypeFromPayload(payload),
          payload: payload as Record<string, unknown>,
          rawBody: options.rawBody,
        };
      }
    }
  }

  throw new WebhookVerificationError('Webhook signature does not match any configured secret.');
}
