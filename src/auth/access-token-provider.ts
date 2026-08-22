import type { ResolvedConfig, ServiceHost } from '../config.js';
import { sha256Hex } from '../crypto.js';
import { AuthenticationError, ConnectionError } from '../errors.js';
import { parseEnvelope, toApiError } from '../http/response.js';
import { ResponseCode } from '../response-code.js';
import type { AccessTokenSigner } from './access-token-signer.js';
import type { TokenProvider } from './token-provider.js';

/** Seconds shaved off `expires_in` so a token is never used at the edge of its life. */
const TTL_BUFFER_SECONDS = 60;

/**
 * Cache-aware access-token provider for the payment host.
 *
 * Supports both token schemes:
 *
 * - v1.1 (default): an HMAC-SHA512 signed request — see {@link AccessTokenSigner}.
 * - v1.0 (legacy): HTTP Basic authentication.
 *
 * Concurrent callers within one process share a single in-flight fetch, so a
 * burst of requests on a cold cache produces one token call rather than a
 * stampede. Across processes the cache is whatever {@link ResolvedConfig.tokenStore}
 * provides.
 */
export class AccessTokenProvider implements TokenProvider {
  private inFlight: Promise<string> | null = null;
  private cacheKey: string | null = null;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly signer: AccessTokenSigner,
    private readonly host: ServiceHost = 'payment',
  ) {}

  async token(): Promise<string> {
    const key = await this.key();
    const cached = await this.config.tokenStore.get(key);

    if (cached !== null && cached !== '') {
      return cached;
    }

    // Another caller in this process may already be fetching. Ride along.
    this.inFlight ??= this.fetchToken(key).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  async forget(): Promise<void> {
    await this.config.tokenStore.delete(await this.key());
  }

  private async key(): Promise<string> {
    this.cacheKey ??= `singapay:token:${this.config.environment}:${this.host}:${await sha256Hex(this.config.clientId)}`;

    return this.cacheKey;
  }

  private async fetchToken(key: string): Promise<string> {
    const signed = this.host === 'payment' && this.config.authVersion === '1.1';
    const path = signed ? '/api/v1.1/access-token/b2b' : '/api/v1.0/access-token/b2b';
    const url = `${this.config.baseUrls[this.host]}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-PARTNER-ID': this.config.apiKey,
    };

    if (signed) {
      headers['X-CLIENT-ID'] = this.config.clientId;
      headers['X-Signature'] = await this.signer.sign(
        this.config.clientId,
        this.config.clientSecret,
      );
    } else {
      const basic = btoa(`${this.config.clientId}:${this.config.clientSecret}`);

      headers.Authorization = `Basic ${basic}`;
    }

    let httpResponse: Response;

    try {
      httpResponse = await this.config.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      throw new ConnectionError(`Could not reach the SingaPay token endpoint at ${url}.`, {
        cause,
      });
    }

    const response = parseEnvelope(httpResponse.status, await readJson(httpResponse));
    const accessToken = response.data.access_token;

    if (!response.successful || typeof accessToken !== 'string' || accessToken === '') {
      // A server whose IP is not whitelisted never gets past the token
      // exchange, so this is where SP017 actually surfaces in practice. The
      // cause and the fix are nothing like a bad credential, so it keeps its
      // own error class rather than being flattened into an auth failure.
      if (response.code === ResponseCode.UnauthorizedIp) {
        throw toApiError(response);
      }

      throw new AuthenticationError(
        `SingaPay access-token request failed [HTTP ${response.status}]: ${response.message}`,
      );
    }

    // expires_in arrives as a string on some responses. Keep a refresh buffer,
    // but never cache longer than the token actually lives.
    const expiresIn = Number(response.data.expires_in ?? 0);
    const lifetime = Number.isFinite(expiresIn) ? expiresIn : 0;
    const ttl = Math.max(Math.min(lifetime - TTL_BUFFER_SECONDS, lifetime), 1);

    await this.config.tokenStore.set(key, accessToken, ttl);

    return accessToken;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text === '') {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
