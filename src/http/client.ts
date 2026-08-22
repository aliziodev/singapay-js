import type { RequestSigner } from '../auth/request-signer.js';
import type { TokenProvider } from '../auth/token-provider.js';
import type { ResolvedConfig, ServiceHost } from '../config.js';
import { sha256Hex } from '../crypto.js';
import { ConnectionError, MoneyOutDisabledError } from '../errors.js';
import { normalizeJson } from '../normalize/json-normalizer.js';
import { requiresTokenRefresh } from '../response-code.js';
import type { SingaPayResponse } from './response.js';
import { parseEnvelope, toApiError } from './response.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * An immutable description of one SingaPay API call.
 *
 * Endpoint groups build these and hand them to the client; the test double
 * records them, which is what powers the request assertions.
 */
export interface ApiRequest {
  method: HttpMethod;
  /** Absolute path including the `/api` prefix, with no host. */
  path: string;
  /** Query parameters, appended to the path. */
  query?: Record<string, unknown>;
  /** JSON body, or omitted for body-less requests. */
  body?: unknown;
  /** Whether the request signature (scheme C) is required. */
  signed?: boolean;
  /** Which SingaPay service host receives the call. Defaults to `payment`. */
  host?: ServiceHost;
  /**
   * Whether this call moves funds out, and is therefore subject to the
   * money-out guard. Not the same thing as `signed`: a direct-debit charge is
   * signed but collects money, and locking it behind the guard would force
   * merchants to unlock real disbursement just to accept payments.
   */
  moneyOut?: boolean;
}

/**
 * Percent-encode exactly like RFC 3986.
 *
 * `encodeURIComponent` leaves `!*'()` alone, which RFC 3986 does not. The
 * query string is part of the signed ENDPOINT, so it has to match the URL
 * that actually goes on the wire, byte for byte.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The path with its query string appended — the exact ENDPOINT component the
 * signature covers.
 */
export function buildEndpoint(request: ApiRequest): string {
  const query = request.query;

  if (query === undefined) {
    return request.path;
  }

  const parts: string[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }

    parts.push(`${encodeRfc3986(key)}=${encodeRfc3986(String(value))}`);
  }

  return parts.length === 0 ? request.path : `${request.path}?${parts.join('&')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * HTTP transport for the SingaPay API.
 *
 * Everything that is easy to get wrong lives here, once:
 *
 * - Applies the money-out request signature and sends the *exact* normalized
 *   bytes that were hashed, so the wire body can never drift from the signature.
 * - Enforces the money-out guard.
 * - Retries transient failures on GET only. A write is never retried
 *   automatically, because a blind retry of a money-out call can duplicate a
 *   real transfer.
 * - Refreshes the access token and retries exactly once on SP013 / HTTP 401.
 * - Logs request metadata only. Bodies are never logged, which keeps card
 *   data and credentials out of log files by construction.
 */
export class SingaPayClient {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly tokens: TokenProvider,
    private readonly signer: RequestSigner,
  ) {}

  async send(request: ApiRequest): Promise<SingaPayResponse> {
    if (request.moneyOut === true && !this.config.moneyOutEnabled) {
      throw new MoneyOutDisabledError(`${request.method} ${request.path}`);
    }

    return this.attempt(request, true);
  }

  private async attempt(request: ApiRequest, allowTokenRetry: boolean): Promise<SingaPayResponse> {
    const host = request.host ?? 'payment';
    const endpoint = buildEndpoint(request);
    const url = `${this.config.baseUrls[host]}${endpoint}`;
    const token = await this.tokens.token();
    const startedAt = Date.now();

    const httpResponse = await this.dispatch(request, url, endpoint, token);
    const response = parseEnvelope(httpResponse.status, await readJson(httpResponse));

    this.config.logger.debug('singapay.request', {
      method: request.method,
      path: request.path,
      status: response.status,
      code: response.code,
      durationMs: Date.now() - startedAt,
    });

    if (response.successful) {
      return response;
    }

    if (allowTokenRetry && (response.status === 401 || requiresTokenRefresh(response.code))) {
      await this.tokens.forget();

      return this.attempt(request, false);
    }

    throw toApiError(response);
  }

  private async dispatch(
    request: ApiRequest,
    url: string,
    endpoint: string,
    token: string,
  ): Promise<Response> {
    const host = request.host ?? 'payment';

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };

    if (host !== 'identity') {
      headers['X-PARTNER-ID'] = this.config.apiKey;
    }

    let body: string | undefined;

    if (request.signed === true) {
      // Hash and send the same bytes. Re-serializing between signing and
      // sending is the classic way to produce a valid-looking request the
      // gateway rejects.
      const normalized = normalizeJson(request.body ?? {});
      const timestamp = this.config.clock.unixSeconds();

      headers['Content-Type'] = 'application/json';
      headers['X-Timestamp'] = String(timestamp);
      headers['X-Signature'] = await this.signer.signHashedBody(
        request.method,
        endpoint,
        token,
        await sha256Hex(normalized),
        timestamp,
        this.config.clientSecret,
      );

      body = normalized;
    } else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }

    const init: RequestInit = {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    };

    return this.fetchWithRetry(url, init, request.method === 'GET');
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retryable: boolean,
  ): Promise<Response> {
    const attempts = retryable ? this.config.retryTimes + 1 : 1;
    let lastCause: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.config.fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (response.status < 500 || attempt === attempts) {
          return response;
        }
      } catch (cause) {
        lastCause = cause;

        if (attempt === attempts) {
          throw new ConnectionError(`Could not reach SingaPay at ${url}.`, { cause });
        }
      }

      await sleep(this.config.retryDelayMs);
    }

    throw new ConnectionError(`Could not reach SingaPay at ${url}.`, { cause: lastCause });
  }
}
