import type { JakartaClock } from '../clock.js';
import { hmacSha512Hex } from '../crypto.js';

/**
 * Scheme A — the signature on the access-token v1.1 request.
 *
 * ```
 * payload     = "{client_id}_{client_secret}_{YYYYMMDD}"
 * X-Signature = HMAC-SHA512(payload, client_secret)   // lowercase hex
 * ```
 *
 * The date component is the Asia/Jakarta calendar day, never UTC. The official
 * Node.js example uses `new Date().toISOString()`, which produces yesterday
 * between 00:00 and 07:00 WIB and a signature the gateway rejects.
 */
export class AccessTokenSigner {
  constructor(private readonly clock: JakartaClock) {}

  /**
   * The exact string that gets signed, exposed for debugging tools.
   * Handle with care — it contains the client secret.
   */
  payload(clientId: string, clientSecret: string): string {
    return `${clientId}_${clientSecret}_${this.clock.signatureDate()}`;
  }

  /** The `X-Signature` header value: 128 lowercase hex characters. */
  async sign(clientId: string, clientSecret: string): Promise<string> {
    return hmacSha512Hex(clientSecret, this.payload(clientId, clientSecret));
  }
}
