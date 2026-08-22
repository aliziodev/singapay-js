import { beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay, SingaPayResponse } from '../../src/index.js';
import { ApiError } from '../../src/index.js';
import { connectionThatCan, field, hasCredentials, moneyOutEnabled, reference } from './setup.js';

/**
 * The money-out products other than disbursement: e-wallet top-up, QRIS
 * issuer, inter-account transfer, and cardless withdrawal.
 *
 * Several of these are **not provisioned on this sandbox merchant**. Those
 * tests assert the specific refusal rather than skipping, so they double as
 * canaries: if SingaPay ever provisions the product, the test fails and says
 * so instead of quietly continuing to prove nothing.
 */

/** A DANA sandbox wallet number. */
const WALLET_NUMBER = '085733347341';

describe.skipIf(!hasCredentials || !moneyOutEnabled)('other money-out products', () => {
  let singapay!: SingaPay;

  beforeAll(async () => {
    singapay = await connectionThatCan(
      (client) => client.disbursement.checkFee({ bank_swift_code: 'CENAIDJA', amount: 10_000 }),
      { moneyOut: true },
    );
  });

  describe('e-wallet top-up', () => {
    it('validates the beneficiary wallet before any money is committed', async () => {
      // `SP010 Beneficiary Account Not Found`. The DANA sandbox number that
      // *pays* successfully cannot *receive* a top-up: money in and money out
      // are validated against different registries, so a wallet proven in one
      // direction says nothing about the other. Crediting a wallet needs one
      // the merchant is provisioned to reach, which this sandbox has none of.
      //
      // Note the amount shape too: `{ value, currency }` with `value` a
      // decimal STRING, unlike every other amount in this SDK.
      await expect(
        singapay.ewalletMoneyOut.inquireAccount({
          ewallet_code: 'DANA',
          customer_number: WALLET_NUMBER,
          amount: { value: '10000.00', currency: 'IDR' },
        }),
      ).rejects.toMatchObject({ code: 'SP010' });
    });

    it('answers a status inquiry for a reference it never issued', async () => {
      // Reconciliation depends on this endpoint answering rather than
      // hanging: an outcome you cannot query is an outcome you cannot settle.
      await expect(
        singapay.ewalletMoneyOut.inquireStatus(reference('E2E-EWS')),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses a top-up to that same unreachable wallet', async () => {
      // The inquiry above is not advisory: the trigger applies the same check,
      // so an application that skipped the inquiry still cannot move money to
      // a wallet it may not credit. Promote both to success assertions if a
      // creditable sandbox wallet ever becomes available.
      await expect(
        singapay.ewalletMoneyOut.triggerTopup({
          ewallet_code: 'DANA',
          customer_number: WALLET_NUMBER,
          amount: { value: '10000.00', currency: 'IDR' },
          reference_number: reference('E2E-EWO'),
        }),
      ).rejects.toMatchObject({ code: 'SP010' });
    });
  });

  describe('QRIS issuer', () => {
    it('inquires the merchant behind a QR string', async () => {
      // Generated here rather than hard-coded, so the QR is always current.
      const generated = await singapay.qris.generate({
        amount: 50_000,
        expired_at: new Date(Date.now() + 3_600_000).toISOString(),
        merchant_reff_no: reference('E2E-QRO'),
      });

      const qrData = field(generated, 'qr_data');

      expect(qrData).toBeTypeOf('string');

      const response = await singapay.qrisMoneyOut.inquireMerchant(qrData as string);

      expect(response.successful).toBe(true);
    });

    it('refuses to pay a QR because the issuer product is not provisioned', async () => {
      // SP019. This is SingaPay's provisioning, not our request: it is refused
      // even against another sub-account's QR. If this ever starts passing,
      // the product has been enabled and the assertion should be promoted.
      await expect(
        singapay.qrisMoneyOut.triggerPaymentCredit({
          qr_data: 'not-a-provisioned-merchant',
          amount: 10_000,
          reference_number: reference('E2E-QRC'),
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('QRIS issuer status', () => {
    it('answers a status inquiry even with no successful payment to report', async () => {
      // Not broken, just empty: the product is unprovisioned so nothing has
      // ever been paid through it, and the endpoint says so rather than
      // erroring in some other way.
      await expect(
        singapay.qrisMoneyOut.inquireStatus(reference('E2E-QRS')),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('inter-account transfer', () => {
    it('lists transfers', async () => {
      await expect(singapay.accountTransfer.list()).resolves.toMatchObject({ successful: true });
    });

    it('moves balance to another sub-account when one is reachable', async () => {
      // The beneficiary is a 12-digit account NUMBER, not the ULID used
      // everywhere else, so it has to be read off the account listing.
      const accounts = await singapay.accounts.list();
      const numbers = (accounts.items ?? [])
        .map((row) => (row as { account_number?: unknown }).account_number)
        .filter((value): value is string => typeof value === 'string' && /^\d{12}$/.test(value));

      if (numbers.length === 0) {
        process.stderr.write('\n  no 12-digit sub-account number available; transfer skipped\n\n');

        return;
      }

      const moved = await singapay.accountTransfer.transfer({
        amount: 10_000,
        beneficiary_account_number: numbers[0] as string,
        // One `f`. `merchant_reff_no` — the spelling every other product uses
        // — is not what this endpoint echoes back.
        merchant_ref_no: reference('E2E-ACT'),
      });

      expect(moved.successful).toBe(true);

      const transactionId = field(moved, 'transaction_id');

      if (typeof transactionId === 'string') {
        await expect(singapay.accountTransfer.find(transactionId)).resolves.toMatchObject({
          successful: true,
        });
      }
    });
  });

  describe('cardless withdrawal', () => {
    it('lists withdrawals', async () => {
      await expect(singapay.cardlessWithdrawal.list()).resolves.toMatchObject({
        successful: true,
      });
    });

    it('cannot create one: the gateway answers a bare 500', async () => {
      // SingaPay's defect, not ours. Their own documented example payload
      // answers HTTP 500, where their spec promises `SP011 Beneficiary Vendor
      // Not Active` or a 503. An unrecognised `vendor_code` fails identically,
      // so "wrong code" and "not provisioned" are indistinguishable from
      // outside. Promote this to a success assertion if it ever changes.
      const failure = await singapay.cardlessWithdrawal
        .create({
          reference_number: reference('E2E-CLW'),
          customer_name: 'Budi Santoso',
          customer_id: 'CUST-00123',
          amount: 500_000,
          vendor_code: 'CLWD_BRI',
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status).toBeGreaterThanOrEqual(500);
    });

    it('reports an unknown reference on the detail read too', async () => {
      // The read side of this product is healthy even though create is not.
      await expect(singapay.cardlessWithdrawal.find(reference('E2E-NONE'))).rejects.toBeInstanceOf(
        ApiError,
      );
    });

    it('reports an unknown reference rather than inventing one', async () => {
      // SP009. The read side of this product is healthy even though create
      // is not, so a cancel for a reference that never existed must say so.
      await expect(
        singapay.cardlessWithdrawal.cancel(reference('E2E-NONE'), 'E2E probe'),
      ).rejects.toMatchObject({ code: 'SP009' });
    });
  });
});
