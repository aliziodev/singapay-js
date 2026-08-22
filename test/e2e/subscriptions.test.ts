import { beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay, SingaPayResponse } from '../../src/index.js';
import { connectionThatCan, field, hasCredentials, reference } from './setup.js';

/**
 * Recurring plans against the sandbox.
 *
 * Money-in, so no money-out guard applies. A plan is created unlinked: the
 * customer attaches a payment instrument at `payment_link_url`, and nothing
 * charges until they do.
 */

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Paket Bulanan E2E',
    customer_name: 'Budi Santoso',
    customer_email: 'budi@example.id',
    customer_phone: '081234567890',
    amount: 99_000,
    subscription_id: reference('E2E-SUB'),
    schedule: {
      interval: 1,
      interval_unit: 'month',
      total_interval: 12,
      start_time: new Date(Date.now() + 86_400_000).toISOString(),
    },
    ...overrides,
  };
}

describe.skipIf(!hasCredentials)('subscriptions', () => {
  let singapay!: SingaPay;

  beforeAll(async () => {
    singapay = await connectionThatCan((client) => client.paymentLinks.list());
  });

  it('creates, finds and cancels a plan', async () => {
    const created = await singapay.subscriptions.createPlan(plan());

    expect(created.successful).toBe(true);

    const id = field(created, 'id');

    expect(id).toBeTypeOf('string');

    // Nothing can be charged until the customer links an instrument here.
    expect(field(created, 'payment_link_url')).toBeTypeOf('string');
    expect(field(created, 'status')).toBe('pending_card_linking');

    await expect(singapay.subscriptions.findPlan(id as string)).resolves.toMatchObject({
      successful: true,
    });

    await expect(
      singapay.subscriptions.cancelPlan(id as string, 'E2E cleanup'),
    ).resolves.toMatchObject({ successful: true });
  });

  it('refuses an upgrade until the customer has linked a card', async () => {
    // `409 SP102`. A plan is born `pending_card_linking`, and changing the
    // amount — the way an upgrade or downgrade is expressed — is rejected
    // until it goes active. So an application cannot create a plan and price
    // it in the same flow; the proration path is unreachable from a cold
    // start, and only a customer completing the linking can open it.
    const created = await singapay.subscriptions.createPlan(plan());
    const id = field(created, 'id') as string;

    await expect(singapay.subscriptions.updatePlan(id, { amount: 149_000 })).rejects.toMatchObject({
      code: 'SP102',
    });

    await singapay.subscriptions.cancelPlan(id, 'E2E cleanup');
  });

  it('honours subscription_id and silently discards merchant_reff_no', async () => {
    // The trap: `merchant_reff_no` is accepted without complaint and thrown
    // away, so a correlation key stored there is simply lost. Every other
    // money-in product in this gateway uses it, which is what makes the
    // exception dangerous.
    const mine = reference('E2E-CORR');
    const created = await singapay.subscriptions.createPlan(
      plan({ subscription_id: mine, merchant_reff_no: 'THIS-IS-DISCARDED' }),
    );

    expect(created.successful).toBe(true);
    expect(field(created, 'subscription_id')).toBe(mine);
    expect(field(created, 'merchant_reff_no')).toBeNull();

    await singapay.subscriptions.cancelPlan(field(created, 'id') as string, 'E2E cleanup');
  });

  it('generates a subscription_id when none is given', async () => {
    // Built by omission rather than by passing `undefined`: the normalizer
    // rejects an undefined value outright, because inside an array it would
    // silently become null and change the signature.
    const { subscription_id: _omitted, ...withoutId } = plan();
    const created = await singapay.subscriptions.createPlan(withoutId);

    expect(created.successful).toBe(true);
    expect(field(created, 'subscription_id')).toBeTypeOf('string');

    await singapay.subscriptions.cancelPlan(field(created, 'id') as string, 'E2E cleanup');
  });
});
