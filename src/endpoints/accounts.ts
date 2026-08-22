import type { SingaPayResponse } from '../http/response.js';
import type { QueryFilters, RequestBody } from './base.js';
import { EndpointGroup } from './base.js';

/**
 * Sub-account management.
 *
 * A merchant holds one merchant-level balance plus any number of sub-accounts,
 * each with its own ULID and its own balance.
 */
export class Accounts extends EndpointGroup {
  /** `GET /api/v1.0/accounts` */
  list(): Promise<SingaPayResponse> {
    return this.send({ method: 'GET', path: '/api/v1.0/accounts' });
  }

  /** `POST /api/v1.0/accounts` */
  create(data: RequestBody): Promise<SingaPayResponse> {
    return this.send({ method: 'POST', path: '/api/v1.0/accounts', body: data });
  }

  /** `GET /api/v1.0/accounts/{id}` */
  find(accountId: string): Promise<SingaPayResponse> {
    return this.send({ method: 'GET', path: `/api/v1.0/accounts/${this.segment(accountId)}` });
  }

  /** `PATCH /api/v1.0/accounts/update/{id}` */
  update(accountId: string, data: RequestBody): Promise<SingaPayResponse> {
    return this.send({
      method: 'PATCH',
      path: `/api/v1.0/accounts/update/${this.segment(accountId)}`,
      body: data,
    });
  }

  /**
   * Activate or deactivate a sub-account.
   *
   * @param status `active` or `inactive`.
   */
  updateStatus(accountId: string, status: string): Promise<SingaPayResponse> {
    return this.update(accountId, { status });
  }

  /**
   * Delete a sub-account. Fails with HTTP 400 while the account still holds a
   * balance.
   *
   * `DELETE /api/v1.0/accounts/{id}` — absent from `merchant-api.json` but
   * verified working in sandbox, so do not remove it on the strength of the
   * spec alone.
   */
  delete(accountId: string): Promise<SingaPayResponse> {
    return this.send({ method: 'DELETE', path: `/api/v1.0/accounts/${this.segment(accountId)}` });
  }
}

/** Balance inquiry, at merchant and sub-account level. */
export class Balance extends EndpointGroup {
  /** Merchant-wide balance. `GET /api/v1.0/balance-inquiry` */
  merchant(): Promise<SingaPayResponse> {
    return this.send({ method: 'GET', path: '/api/v1.0/balance-inquiry' });
  }

  /** One sub-account balance. `GET /api/v1.0/balance-inquiry/{account_id}` */
  account(accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/balance-inquiry/${this.accountPath(accountId)}`,
    });
  }
}

/** Account statements — the ledger behind the balance. */
export class Statements extends EndpointGroup {
  /** `GET /api/v1.0/statements/{account_id}` */
  list(accountId?: string, filters?: QueryFilters): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/statements/${this.accountPath(accountId)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }

  /** `GET /api/v1.0/statements/{account_id}/{statement_id}` */
  find(statementId: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/statements/${this.accountPath(accountId)}/${this.segment(statementId)}`,
    });
  }
}
