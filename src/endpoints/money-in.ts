import type { SingaPayResponse } from '../http/response.js';
import type { QueryFilters, RequestBody } from './base.js';
import { EndpointGroup } from './base.js';

/** Virtual account management. */
export class VirtualAccounts extends EndpointGroup {
  /** `GET /api/v1.0/virtual-accounts/{account_id}` */
  list(accountId?: string, filters?: QueryFilters): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/virtual-accounts/${this.accountPath(accountId)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }

  /** `POST /api/v1.0/virtual-accounts/{account_id}` */
  create(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v1.0/virtual-accounts/${this.accountPath(accountId)}`,
      body: data,
    });
  }

  /** `GET /api/v1.0/virtual-accounts/{account_id}/{va_id}` */
  find(virtualAccountId: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/virtual-accounts/${this.accountPath(accountId)}/${this.segment(virtualAccountId)}`,
    });
  }

  /** `PUT /api/v1.0/virtual-accounts/{account_id}/{va_id}` */
  update(
    virtualAccountId: string,
    data: RequestBody,
    accountId?: string,
  ): Promise<SingaPayResponse> {
    return this.send({
      method: 'PUT',
      path: `/api/v1.0/virtual-accounts/${this.accountPath(accountId)}/${this.segment(virtualAccountId)}`,
      body: data,
    });
  }

  /** `DELETE /api/v1.0/virtual-accounts/{account_id}/{va_id}` */
  delete(virtualAccountId: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'DELETE',
      path: `/api/v1.0/virtual-accounts/${this.accountPath(accountId)}/${this.segment(virtualAccountId)}`,
    });
  }
}

/** Payments received on virtual accounts. */
export class VaTransactions extends EndpointGroup {
  /** `GET /api/v1.0/va-transactions/{account_id}` */
  list(accountId?: string, filters?: QueryFilters): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/va-transactions/${this.accountPath(accountId)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }

  /** `GET /api/v1.0/va-transactions/{account_id}/{transaction_id}` */
  find(transactionId: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/va-transactions/${this.accountPath(accountId)}/${this.segment(transactionId)}`,
    });
  }

  /** `GET /api/v1.0/va-transactions/{account_id}/detail-by-va-number/{va_number}` */
  listByVaNumber(
    vaNumber: string,
    accountId?: string,
    filters?: QueryFilters,
  ): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/va-transactions/${this.accountPath(accountId)}/detail-by-va-number/${this.segment(vaNumber)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }
}

/**
 * Payment link management.
 *
 * `create()`, `find()` and `update()` use the v2 API, which the gateway marks
 * as current. `list()`, `delete()` and `paymentMethods()` stay on v1 because
 * v2 has no equivalent.
 *
 * Rules worth knowing:
 * - `payment_link_type` decides the shape: `total` takes `total_amount` and
 *   ignores `items`; `items` takes `items` and computes the total server-side.
 * - `reff_no` is at most 40 characters, with no spaces or slashes.
 * - `payment_link_id` is the numeric id, not a ULID.
 * - `max_usage` defaults to 1; `0` means unlimited.
 */
export class PaymentLinks extends EndpointGroup {
  /** `GET /api/v1.0/payment-link-manage/{account_id}` */
  list(accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/payment-link-manage/${this.accountPath(accountId)}`,
    });
  }

  /**
   * The payment method codes accepted by `whitelisted_payment_method`.
   *
   * `GET /api/v1.0/payment-link-manage/payment-methods`
   */
  paymentMethods(): Promise<SingaPayResponse> {
    return this.send({ method: 'GET', path: '/api/v1.0/payment-link-manage/payment-methods' });
  }

  /** `POST /api/v2.0/payment-link/{account_id}` */
  create(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v2.0/payment-link/${this.accountPath(accountId)}`,
      body: data,
    });
  }

  /**
   * `GET /api/v2.0/payment-link/{payment_link_id}` — v2 resolves and
   * access-checks the owning account from the link itself, so no account id
   * is needed.
   */
  find(paymentLinkId: number): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v2.0/payment-link/${this.segment(paymentLinkId)}`,
    });
  }

  /**
   * `PUT /api/v2.0/payment-link/update/{payment_link_id}`
   *
   * `reff_no`, `total_amount` and `items` are immutable — create a new link
   * instead. Every other field is optional and omitting one leaves it alone.
   */
  update(paymentLinkId: number, data: RequestBody): Promise<SingaPayResponse> {
    return this.send({
      method: 'PUT',
      path: `/api/v2.0/payment-link/update/${this.segment(paymentLinkId)}`,
      body: data,
    });
  }

  /**
   * `DELETE /api/v1.0/payment-link-manage/{account_id}/{payment_link_id}` —
   * blocked with 403 once the link has any payment history.
   */
  delete(paymentLinkId: number, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'DELETE',
      path: `/api/v1.0/payment-link-manage/${this.accountPath(accountId)}/${this.segment(paymentLinkId)}`,
    });
  }
}

/** Payments collected through payment links. */
export class PaymentLinkHistories extends EndpointGroup {
  /** `GET /api/v1.0/payment-link-histories/{account_id}` */
  list(accountId?: string, filters?: QueryFilters): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/payment-link-histories/${this.accountPath(accountId)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }

  /** `GET /api/v1.0/payment-link-histories/{account_id}/{history_id}` */
  find(historyId: number, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/payment-link-histories/${this.accountPath(accountId)}/${this.segment(historyId)}`,
    });
  }
}

/** Dynamic QRIS as acquirer — the merchant collects. */
export class Qris extends EndpointGroup {
  /** `POST /api/v1.0/qris-dynamic/{account_id}/generate-qr` */
  generate(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v1.0/qris-dynamic/${this.accountPath(accountId)}/generate-qr`,
      body: data,
    });
  }

  /** `GET /api/v1.0/qris-dynamic/{account_id}` */
  list(accountId?: string, filters?: QueryFilters): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/qris-dynamic/${this.accountPath(accountId)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }

  /** `GET /api/v1.0/qris-dynamic/{account_id}/show/{id}` */
  find(id: number, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/qris-dynamic/${this.accountPath(accountId)}/show/${this.segment(id)}`,
    });
  }
}

/** E-wallet money in — DANA, OVO, GoPay, ShopeePay. */
export class EwalletMoneyIn extends EndpointGroup {
  /** `POST /api/v1.0/ewallet-native/{account_id}/create-checkout` */
  createCheckout(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v1.0/ewallet-native/${this.accountPath(accountId)}/create-checkout`,
      body: data,
    });
  }

  /** `POST /api/v2.0/ewallet-native/create-order` */
  createOrder(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v2.0/ewallet-native/create-order',
      body: this.withAccountId(data, accountId),
    });
  }

  /** `GET /api/v1.0/ewallet-native-transactions/{account_id}` */
  listTransactions(accountId?: string, filters?: QueryFilters): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/ewallet-native-transactions/${this.accountPath(accountId)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }

  /** `GET /api/v1.0/ewallet-native-transactions/{account_id}/{transaction_id}` */
  findTransaction(transactionId: number, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/ewallet-native-transactions/${this.accountPath(accountId)}/${this.segment(transactionId)}`,
    });
  }

  /** `GET /api/v1.0/ewallet-native/{account_id}/inquiry-status/{id}` */
  inquireStatus(id: number, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/ewallet-native/${this.accountPath(accountId)}/inquiry-status/${this.segment(id)}`,
    });
  }
}

/**
 * Card payments.
 *
 * A server that touches raw card numbers is in PCI-DSS scope. Use a payment
 * link instead unless you fully understand the consequences.
 */
export class Card extends EndpointGroup {
  /** `POST /api/v2.0/card/{account_id}/payment` */
  payment(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v2.0/card/${this.accountPath(accountId)}/payment`,
      body: data,
    });
  }

  /** `PATCH /api/v2.0/card/{account_id}/cancel/{id}` */
  cancel(id: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'PATCH',
      path: `/api/v2.0/card/${this.accountPath(accountId)}/cancel/${this.segment(id)}`,
    });
  }

  /** `GET /api/v2.0/card/{account_id}/inquiry-status/{id}` */
  inquireStatus(id: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v2.0/card/${this.accountPath(accountId)}/inquiry-status/${this.segment(id)}`,
    });
  }
}

/**
 * Direct debit — card binding then recurring charges.
 *
 * `charge()` carries the money-out signature because the gateway requires it,
 * but it is *not* behind the money-out guard: it collects money rather than
 * moving it out, and guarding it would force merchants to unlock real
 * disbursement just to accept payments.
 */
export class DirectDebit extends EndpointGroup {
  /** `POST /api/v2.0/direct-debit/binding` */
  bindCard(data: RequestBody): Promise<SingaPayResponse> {
    return this.send({ method: 'POST', path: '/api/v2.0/direct-debit/binding', body: data });
  }

  /** `GET /api/v2.0/direct-debit/binding/{binding_id}` */
  bindingStatus(bindingId: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v2.0/direct-debit/binding/${this.segment(bindingId)}`,
    });
  }

  /** `POST /api/v2.0/direct-debit/binding/{binding_id}/unbind` */
  unbindCard(bindingId: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v2.0/direct-debit/binding/${this.segment(bindingId)}/unbind`,
      body: {},
    });
  }

  /** `POST /api/v2.0/direct-debit/charge` — signed, but money *in*. */
  charge(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v2.0/direct-debit/charge',
      body: this.withAccountId(data, accountId),
      signed: true,
    });
  }

  /** `POST /api/v2.0/direct-debit/verify-otp` */
  verifyOtp(data: RequestBody): Promise<SingaPayResponse> {
    return this.send({ method: 'POST', path: '/api/v2.0/direct-debit/verify-otp', body: data });
  }

  /** `GET /api/v2.0/direct-debit/transaction/{transaction_id}` */
  findTransaction(transactionId: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v2.0/direct-debit/transaction/${this.segment(transactionId)}`,
    });
  }
}

/** Recurring plans and their billing cycles. */
export class Subscriptions extends EndpointGroup {
  /** `POST /api/v2.0/recurring/plans` */
  createPlan(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v2.0/recurring/plans',
      body: this.withAccountId(data, accountId),
    });
  }

  /** `GET /api/v2.0/recurring/plans/{plan_id}` */
  findPlan(planId: string): Promise<SingaPayResponse> {
    return this.send({ method: 'GET', path: `/api/v2.0/recurring/plans/${this.segment(planId)}` });
  }

  /** `PATCH /api/v2.0/recurring/plans/{plan_id}` */
  updatePlan(planId: string, data: RequestBody): Promise<SingaPayResponse> {
    return this.send({
      method: 'PATCH',
      path: `/api/v2.0/recurring/plans/${this.segment(planId)}`,
      body: data,
    });
  }

  /** `POST /api/v2.0/recurring/plans/cancel/{plan_id}` */
  cancelPlan(planId: string, reason?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v2.0/recurring/plans/cancel/${this.segment(planId)}`,
      body: reason === undefined ? {} : { reason },
    });
  }
}
