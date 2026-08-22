import { beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay, SingaPayResponse } from '../../src/index.js';
import { ApiError } from '../../src/index.js';
import { connectionThatCan, field, hasCredentials, reference } from './setup.js';

/**
 * Card payments against the sandbox.
 *
 * Money-in, so no money-out guard applies. A server that handles raw card
 * numbers is inside PCI-DSS scope — this suite exists to prove the endpoints
 * work, not to suggest the approach. Payment Link is the right default.
 *
 * **The sandbox enforces a daily count limit on this product.** One payment is
 * made per run and shared by every test that needs one; taking a fresh payment
 * per test spent the quota within a few runs and turned the suite red for
 * reasons that had nothing to do with the code.
 *
 * **`SP001` is overloaded here.** Elsewhere in this gateway it means "outcome
 * unknown, go and inquire", and the SDK maps it to `IndeterminateOutcomeError`
 * accordingly. On the card product it *also* carries "card expiry malformed"
 * and "daily transaction limit count over", both of which are definite
 * refusals. Never feed a card `SP001` into retry-or-inquire logic without
 * reading the message first.
 */

/** The universal test PAN. */
const CARD_NUMBER = '4111111111111111';

/** December 2030, in the order the API wants. */
const CARD_EXPIRY_YYMM = '3012';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amount: 150_000,
    goods_name: reference('E2E Card'),
    customer_name: 'Budi Santoso',
    customer_email: 'budi@example.id',
    customer_phone: '081234567890',
    customer_address: 'Jalan Merdeka 1',
    customer_city: 'Jakarta',
    customer_state: 'DKI Jakarta',
    customer_postal_code: '10110',
    customer_country: 'ID',
    card_number: CARD_NUMBER,
    card_expiry: CARD_EXPIRY_YYMM,
    card_cvv: '123',
    card_holder_name: 'Budi Santoso',
    card_holder_email: 'budi@example.id',
    ...overrides,
  };
}

function isDailyLimit(error: unknown): boolean {
  return error instanceof Error && /daily transaction limit/i.test(error.message);
}

describe.skipIf(!hasCredentials)('card', () => {
  let singapay!: SingaPay;
  let paid: SingaPayResponse | null = null;
  let quotaExhausted = false;

  beforeAll(async () => {
    singapay = await connectionThatCan((client) => client.paymentLinks.list());

    try {
      paid = await singapay.card.payment(payload());
    } catch (error) {
      if (!isDailyLimit(error)) {
        throw error;
      }

      quotaExhausted = true;
      process.stderr.write('\n  card daily limit reached; payment-dependent tests skipped\n\n');
    }
  });

  /** The shared payment, or null when today's sandbox quota is spent. */
  function payment(): SingaPayResponse | null {
    if (quotaExhausted) {
      return null;
    }

    expect(paid).not.toBeNull();

    return paid;
  }

  it('takes a payment', () => {
    const response = payment();

    if (response === null) {
      return;
    }

    expect(response.successful).toBe(true);
    expect(field(response, 'transaction_id')).toBeTypeOf('string');
  });

  it('reports its status by transaction id', async () => {
    const response = payment();

    if (response === null) {
      return;
    }

    await expect(
      singapay.card.inquireStatus(field(response, 'transaction_id') as string),
    ).resolves.toMatchObject({ successful: true });
  });

  it('accepts the provider transaction id for status just as well', async () => {
    const response = payment();

    if (response === null) {
      return;
    }

    const providerId = field(response, 'provider_transaction_id');

    expect(providerId).toBeTypeOf('string');

    await expect(singapay.card.inquireStatus(providerId as string)).resolves.toMatchObject({
      successful: true,
    });
  });

  it('either cancels, or refuses with SP012 because it already settled', async () => {
    // A genuine race, observed both ways minutes apart: a card payment may or
    // may not have settled by the time the cancel lands. So the assertion is
    // that exactly one of two outcomes happens — cancelled, or refused with
    // `SP012` — and never anything else. An application must handle both:
    // treating SP012 as an error raises false alarms, and assuming the cancel
    // worked leaves money captured.
    const response = payment();

    if (response === null) {
      return;
    }

    try {
      const cancelled = await singapay.card.cancel(field(response, 'transaction_id') as string);

      expect(cancelled.successful).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('SP012');
    }
  });

  it('reads card_expiry as YYMM, not MMYY', async () => {
    // `1230` looks like December 2030 to every other payment API and is
    // refused here — SP001 again, malformed input wearing the code that
    // elsewhere means "outcome unknown".
    await expect(singapay.card.payment(payload({ card_expiry: '1230' }))).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
