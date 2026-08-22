import { beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay } from '../../src/index.js';
import { ApiError, IndeterminateOutcomeError, MoneyOutDisabledError } from '../../src/index.js';
import {
  connectionThatCan,
  firstRow,
  hasCredentials,
  moneyOutEnabled,
  reference,
  sharedClient,
} from './setup.js';

/**
 * Disbursement against the sandbox.
 *
 * Every call here moves a real sandbox balance, so the suite stays off unless
 * `SINGAPAY_MONEY_OUT=true` and it makes exactly one transfer per run.
 *
 * **Transfer and the pre-flight checks speak different vocabularies**, and the
 * gateway refuses a request that mixes them up:
 *
 * | Call | Bank field | Account field |
 * |---|---|---|
 * | `transfer()` | `bank_code` — three digits or SWIFT | `bank_account_number` |
 * | `checkFee()` `checkBeneficiary()` | `bank_swift_code` — SWIFT only | `bank_account_number` |
 *
 * **The sandbox picks the outcome from the account-number prefix**, and the
 * dashboard's own hint about this is wrong in both directions. Measured over
 * 14 transfers on the Laravel sibling, read from the real webhooks:
 *
 * | Prefix | Outcome |
 * |---|---|
 * | `1000` `1002` `1006` `1007` `1008` `4000` | Success |
 * | `1001` | Failed — `ACCOUNT-Bad Request` |
 * | `1003` | Failed — `ACCOUNT-Insufficient Funds` |
 * | `1004` | Failed — `ACCOUNT-INTERNAL_SERVER_ERROR` |
 * | `1005` | Failed — `ACCOUNT-Invalid Account` |
 *
 * The remaining digits are free, but the total length must match the bank's —
 * an arbitrary number hangs `Pending` forever rather than failing. Failures
 * settle far slower than successes (7–10 minutes), so nothing here waits for a
 * final state: **`Pending` never means failed.**
 */

/** BCA. Their published bank table is wider than the API actually accepts. */
const BANK_CODE = '014';
const BANK_SWIFT = 'CENAIDJA';

/** Prefix `1000` plus six digits — BCA account numbers are ten long. */
const SUCCESS_ACCOUNT = '1000123456';

/** The gateway enforces a 10,000 minimum; 5,000 answers `422 amount`. */
const AMOUNT = 10_000;

describe.skipIf(!hasCredentials)('money-out guard', () => {
  it('refuses every fund-moving call while the guard is closed', async () => {
    const locked = sharedClient();

    await expect(
      locked.disbursement.transfer({
        reference_number: 'SHOULD-NEVER-REACH-THE-GATEWAY',
        amount: AMOUNT,
        bank_account_number: SUCCESS_ACCOUNT,
        bank_code: BANK_CODE,
      }),
    ).rejects.toBeInstanceOf(MoneyOutDisabledError);
  });
});

describe.skipIf(!hasCredentials || !moneyOutEnabled)('disbursement', () => {
  let singapay!: SingaPay;

  beforeAll(async () => {
    // Probe with checkFee: read-only, account-scoped, and gated the same way
    // the transfer below will be.
    singapay = await connectionThatCan(
      (client) => client.disbursement.checkFee({ bank_swift_code: BANK_SWIFT, amount: AMOUNT }),
      { moneyOut: true },
    );

    process.stderr.write(`\n  disbursing as connection "${singapay.config.connectionName}"\n\n`);
  });

  it('lists disbursements, and reads one back', async () => {
    const listed = await singapay.disbursement.list();

    expect(listed.successful).toBe(true);

    const row = firstRow(listed);

    if (row === null) {
      process.stderr.write('\n  no disbursements yet; find skipped\n\n');

      return;
    }

    await expect(
      singapay.disbursement.find(String(row.transaction_id ?? row.id)),
    ).resolves.toMatchObject({ successful: true });
  });

  it('quotes a transfer fee', async () => {
    const response = await singapay.disbursement.checkFee({
      bank_swift_code: BANK_SWIFT,
      amount: AMOUNT,
    });

    expect(response.successful).toBe(true);
  });

  it('resolves a beneficiary before anything is promised to a customer', async () => {
    // This one path takes no account id — calling a route that does not serve
    // it was a real bug on the Laravel side.
    const response = await singapay.disbursement.checkBeneficiary({
      bank_swift_code: BANK_SWIFT,
      bank_account_number: SUCCESS_ACCOUNT,
    });

    expect(response.successful).toBe(true);
    expect(response.data).toBeTypeOf('object');
  });

  it('refuses a three-digit bank code where the checks want a SWIFT code', async () => {
    // The two vocabularies are not interchangeable, and the failure is a plain
    // 422 rather than anything that names the mix-up.
    await expect(
      singapay.disbursement.checkBeneficiary({
        bank_code: BANK_CODE,
        bank_account_number: SUCCESS_ACCOUNT,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a bank_swift_code field on transfer', async () => {
    // SP018. Validation fails before anything moves, so this is safe to make.
    await expect(
      singapay.disbursement.transfer({
        reference_number: reference('E2E-REJECT'),
        amount: AMOUNT,
        bank_account_number: SUCCESS_ACCOUNT,
        bank_swift_code: BANK_SWIFT,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('transfers, and can be asked about the outcome afterwards', async () => {
    const referenceNumber = reference('E2E-DISB');
    let accepted = false;

    try {
      const response = await singapay.disbursement.transfer({
        reference_number: referenceNumber,
        amount: AMOUNT,
        bank_account_number: SUCCESS_ACCOUNT,
        bank_code: BANK_CODE,
      });

      accepted = response.successful;
    } catch (error) {
      // SP001 / SP005 do not mean the transfer failed — the outcome is simply
      // unknown. The only correct move is to ask, never to retry.
      if (!(error instanceof IndeterminateOutcomeError)) {
        throw error;
      }
    }

    // Whether it was accepted or came back indeterminate, the reference must
    // now be answerable. That is the property the whole money-out contract
    // rests on: an outcome you cannot query is an outcome you cannot reconcile.
    const status = await singapay.disbursement.inquireStatus(referenceNumber);

    expect(status.status).toBe(200);
    expect(status.data).toBeTypeOf('object');

    if (accepted) {
      expect(status.successful).toBe(true);
    }
  });
});
