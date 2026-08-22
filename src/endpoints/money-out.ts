import type { SingaPayResponse } from '../http/response.js';
import type { QueryFilters, RequestBody } from './base.js';
import { EndpointGroup } from './base.js';

/**
 * Every call in this file that moves funds is marked `moneyOut`, so it throws
 * {@link MoneyOutDisabledError} unless the guard is explicitly enabled.
 *
 * After an SP001, SP005, or a timeout on any of them, never retry blindly:
 * call `inquireStatus()` with the same reference number first. A blind retry
 * can duplicate a real transfer.
 */

/** Disbursement — transfer to a bank account. */
export class Disbursement extends EndpointGroup {
  /** `GET /api/v1.0/disbursement/{account_id}` */
  list(accountId?: string, filters?: QueryFilters): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/disbursement/${this.accountPath(accountId)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }

  /** `GET /api/v1.0/disbursement/{account_id}/{transaction_id}` */
  find(transactionId: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/disbursement/${this.accountPath(accountId)}/${this.segment(transactionId)}`,
    });
  }

  /** `POST /api/v1.0/disbursement/{account_id}/check-fee` */
  checkFee(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v1.0/disbursement/${this.accountPath(accountId)}/check-fee`,
      body: data,
    });
  }

  /** `POST /api/v1.0/disbursement/check-beneficiary` */
  checkBeneficiary(data: RequestBody): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v1.0/disbursement/check-beneficiary',
      body: data,
    });
  }

  /** `POST /api/v2.0/disbursement/transfer` — signed, and moves funds out. */
  transfer(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v2.0/disbursement/transfer',
      body: this.withAccountId(data, accountId),
      signed: true,
      moneyOut: true,
    });
  }

  /**
   * `POST /api/v2.0/disbursement/{account_id}/inquiry-status`
   *
   * Call this after any indeterminate outcome, before deciding anything else.
   */
  inquireStatus(referenceNumber: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v2.0/disbursement/${this.accountPath(accountId)}/inquiry-status`,
      body: { reference_number: referenceNumber },
    });
  }
}

/** E-wallet money out — top up a customer e-wallet. */
export class EwalletMoneyOut extends EndpointGroup {
  /** `POST /api/v2.0/ewallet/account-inquiry` */
  inquireAccount(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v2.0/ewallet/account-inquiry',
      body: this.withAccountId(data, accountId),
    });
  }

  /** `POST /api/v2.0/ewallet/trigger-topup` — signed, and moves funds out. */
  triggerTopup(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v2.0/ewallet/trigger-topup',
      body: this.withAccountId(data, accountId),
      signed: true,
      moneyOut: true,
    });
  }

  /** `POST /api/v2.0/ewallet/{account_id}/inquiry-status` */
  inquireStatus(referenceNumber: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v2.0/ewallet/${this.accountPath(accountId)}/inquiry-status`,
      body: { reference_number: referenceNumber },
    });
  }
}

/** QRIS as issuer — pay a merchant QR from the merchant balance. */
export class QrisMoneyOut extends EndpointGroup {
  /** `POST /api/v2.0/qris/issuer/mpm/inquiry-merchant` */
  inquireMerchant(qrData: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v2.0/qris/issuer/mpm/inquiry-merchant',
      body: { qr_data: qrData },
    });
  }

  /** `POST /api/v2.0/qris/issuer/mpm/payment-credit` — signed, and moves funds out. */
  triggerPaymentCredit(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v2.0/qris/issuer/mpm/payment-credit',
      body: this.withAccountId(data, accountId),
      signed: true,
      moneyOut: true,
    });
  }

  /** `POST /api/v2.0/qris/status/{account_id}` */
  inquireStatus(
    referenceNumber: string,
    scope = 'issuer',
    accountId?: string,
  ): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v2.0/qris/status/${this.accountPath(accountId)}`,
      body: { reference_number: referenceNumber, scope },
    });
  }
}

/** Transfers between the merchant own accounts. */
export class AccountTransfer extends EndpointGroup {
  /** `GET /api/v1.0/account-transfer/{account_id}` */
  list(accountId?: string, filters?: QueryFilters): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/account-transfer/${this.accountPath(accountId)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }

  /** `GET /api/v1.0/account-transfer/{account_id}/{transaction_id}` */
  find(transactionId: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/account-transfer/${this.accountPath(accountId)}/${this.segment(transactionId)}`,
    });
  }

  /** `POST /api/v1.0/account-transfer/{account_id}/transfer` — signed, and moves funds out. */
  transfer(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v1.0/account-transfer/${this.accountPath(accountId)}/transfer`,
      body: data,
      signed: true,
      moneyOut: true,
    });
  }
}

/** Cardless withdrawal — a code the customer redeems at an ATM. */
export class CardlessWithdrawal extends EndpointGroup {
  /** `POST /api/v1.0/cardless-withdrawals/create` — signed, and moves funds out. */
  create(data: RequestBody, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v1.0/cardless-withdrawals/create',
      body: this.withAccountId(data, accountId),
      signed: true,
      moneyOut: true,
    });
  }

  /** `GET /api/v1.0/cardless-withdrawals/transaction/{account_id}` */
  list(accountId?: string, filters?: QueryFilters): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/cardless-withdrawals/transaction/${this.accountPath(accountId)}`,
      ...(filters === undefined ? {} : { query: filters }),
    });
  }

  /** `GET /api/v1.0/cardless-withdrawals/transaction/{account_id}/{reference_number}` */
  find(referenceNumber: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1.0/cardless-withdrawals/transaction/${this.accountPath(accountId)}/${this.segment(referenceNumber)}`,
    });
  }

  /** `POST /api/v1.0/cardless-withdrawals/cancel` */
  cancel(referenceNumber: string, reason: string, accountId?: string): Promise<SingaPayResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v1.0/cardless-withdrawals/cancel',
      body: this.withAccountId({ reference_number: referenceNumber, reason }, accountId),
    });
  }
}
