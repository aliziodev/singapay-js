import type { ResolvedConfig } from '../config.js';
import { requireAccountId } from '../config.js';
import type { ApiRequest, SingaPayClient } from '../http/client.js';
import { encodeRfc3986 } from '../http/client.js';
import type { SingaPayResponse } from '../http/response.js';

/** A request body, as accepted by the endpoint methods. */
export type RequestBody = Record<string, unknown>;

/** Query filters, as accepted by the list endpoints. */
export type QueryFilters = Record<string, unknown>;

/**
 * Base for the endpoint groups.
 *
 * Endpoint groups are thin, typed wrappers: they know paths, path-parameter
 * types, and which calls need the money-out signature. Everything else —
 * auth, signing, retries, envelopes, errors — lives in the client.
 */
export abstract class EndpointGroup {
  constructor(
    protected readonly client: SingaPayClient,
    protected readonly config: ResolvedConfig,
  ) {}

  protected send(request: ApiRequest): Promise<SingaPayResponse> {
    return this.client.send(request);
  }

  /**
   * An explicit account ULID or the configured default, encoded for safe
   * interpolation into a path.
   */
  protected accountPath(accountId?: string): string {
    return this.segment(requireAccountId(this.config, accountId));
  }

  /**
   * Percent-encode a path segment.
   *
   * Every identifier interpolated into a path goes through this, so a value
   * that came from user input can never break out of its segment, reach a
   * different endpoint, or smuggle a query string into the signed ENDPOINT.
   */
  protected segment(value: string | number): string {
    return encodeRfc3986(String(value));
  }

  /**
   * Merge the default account ULID into a body when absent, for the v2
   * endpoints that carry `account_id` in the body rather than the path.
   */
  protected withAccountId(data: RequestBody, accountId?: string): RequestBody {
    if (data.account_id !== undefined) {
      return data;
    }

    return { ...data, account_id: requireAccountId(this.config, accountId) };
  }
}
