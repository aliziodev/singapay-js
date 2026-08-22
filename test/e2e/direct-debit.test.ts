import { beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay, SingaPayResponse } from '../../src/index.js';
import { ApiError } from '../../src/index.js';
import { connectionThatCan, field, hasCredentials, reference } from './setup.js';

/**
 * Direct debit against the sandbox.
 *
 * SingaPay marks this product **SOON** and no test card is published for it,
 * so the binding a charge needs can never be driven to `ACTIVE` from here.
 * Everything up to that wall is still exercised, and everything past it
 * asserts the specific refusal — which makes these tests canaries: the day the
 * product ships, they fail and say so.
 *
 * Money-in, despite the signed requests: a charge collects from a customer
 * rather than moving funds out, so the money-out guard does not apply.
 */

describe.skipIf(!hasCredentials)('direct debit', () => {
  let singapay!: SingaPay;
  let bindingId: string | null = null;

  beforeAll(async () => {
    singapay = await connectionThatCan((client) => client.paymentLinks.list());
  });

  it('creates a card binding and hands back a linking URL', async () => {
    const binding = await singapay.directDebit.bindCard({
      // 4-15 characters. A longer one is refused `SP018 Validation error`
      // with no field named, which reads like the product being unavailable.
      customer_ref: reference('DD'),
      // Digits only. A leading `+` is refused with `SP002 General Failure`,
      // which says nothing at all about the cause.
      phone_no: '081234567890',
    });

    expect(binding.successful).toBe(true);

    const id = field(binding, 'binding_id') ?? field(binding, 'id');

    expect(id).toBeTypeOf('string');
    bindingId = id as string;

    // The customer has to finish linking in this webview; there is no
    // automated path to it, which is what makes the rest unreachable.
    expect(field(binding, 'redirect_url')).toBeTypeOf('string');
    expect(field(binding, 'status')).toBe('PENDING_AUTH');
  });

  it('reports the binding status', async () => {
    expect(bindingId).not.toBeNull();

    const status = await singapay.directDebit.bindingStatus(bindingId ?? '');

    expect(status.successful).toBe(true);

    // If this ever reads ACTIVE without a human completing the webview, the
    // product has changed and the charge path below is worth re-testing.
    expect(field(status, 'status')).toBe('PENDING_AUTH');
  });

  it('refuses a charge against a binding that is not active', async () => {
    // `SP018`. This is the wall: no published test card can drive a binding
    // to ACTIVE, so a successful charge is unreachable from a test suite.
    await expect(
      singapay.directDebit.charge({
        binding_id: bindingId ?? '',
        amount: 50_000,
        reference_number: reference('E2E-DDC'),
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('cannot unbind a binding that never went active', async () => {
    expect(bindingId).not.toBeNull();

    // `HTTP 500 SP002 General Failure` — SingaPay's own catch-all, which says
    // nothing about the cause. Since no binding here can reach `ACTIVE`, the
    // only unbind reachable from a test is this one, and it is the same
    // contentless failure a malformed phone number produces. Promote this to
    // a success assertion if the product ever ships.
    await expect(singapay.directDebit.unbindCard(bindingId ?? '')).rejects.toMatchObject({
      code: 'SP002',
    });
  });

  it('requires a transaction or binding reference to verify an OTP', async () => {
    // Needs either `transaction_id`, or `binding_id` plus an `unbind_context`
    // that must be an **array** — a boolean is rejected.
    await expect(singapay.directDebit.verifyOtp({ otp: '123456' })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('reports an unknown transaction rather than inventing one', async () => {
    await expect(singapay.directDebit.findTransaction(reference('E2E-DDT'))).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
