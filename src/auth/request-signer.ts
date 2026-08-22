import { hmacSha512Hex } from '../crypto.js';
import { hashJson } from '../normalize/json-normalizer.js';

/**
 * Scheme C — the request signature for money-moving endpoints, and the same
 * formula used to verify inbound webhooks.
 *
 * ```
 * hashed_body    = SHA-256(normalized_json)
 * string_to_sign = "{METHOD}:{ENDPOINT}:{ACCESS_TOKEN}:{hashed_body}:{TIMESTAMP}"
 * X-Signature    = HMAC-SHA512(string_to_sign, client_secret)   // lowercase hex
 * ```
 *
 * - `METHOD` is uppercase.
 * - `ENDPOINT` is the path including the `/api` prefix and any query string,
 *   with no scheme or host.
 * - `ACCESS_TOKEN` is the bearer token without the `Bearer ` prefix. For a
 *   webhook this is the token SingaPay sent us, not our own.
 * - `TIMESTAMP` is Unix seconds — the `X-Timestamp` header value.
 */
export class RequestSigner {
  /** The canonical string-to-sign, exposed for debugging tools. */
  stringToSign(
    method: string,
    endpoint: string,
    accessToken: string,
    hashedBody: string,
    timestamp: number,
  ): string {
    return `${method.toUpperCase()}:${endpoint}:${accessToken}:${hashedBody}:${timestamp}`;
  }

  /**
   * Sign with an already-computed body hash. Used by webhook verification,
   * where the hash comes from the raw request bytes.
   */
  async signHashedBody(
    method: string,
    endpoint: string,
    accessToken: string,
    hashedBody: string,
    timestamp: number,
    clientSecret: string,
  ): Promise<string> {
    return hmacSha512Hex(
      clientSecret,
      this.stringToSign(method, endpoint, accessToken, hashedBody, timestamp),
    );
  }

  /** Sign an outbound request body. */
  async sign(
    method: string,
    endpoint: string,
    accessToken: string,
    body: unknown,
    timestamp: number,
    clientSecret: string,
  ): Promise<string> {
    return this.signHashedBody(
      method,
      endpoint,
      accessToken,
      await hashJson(body ?? {}),
      timestamp,
      clientSecret,
    );
  }
}
