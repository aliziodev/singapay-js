import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay, SingaPayResponse } from '../../src/index.js';
import { connectionThatCan, field, hasCredentials, reference } from './setup.js';

/**
 * Sub-account lifecycle against the sandbox.
 *
 * Everything created here is named with an `E2E` prefix and swept in
 * `afterAll`, so a failing assertion cannot leave the merchant silted up with
 * orphans — which is what happens if cleanup only runs on the happy path.
 *
 * A sub-account holding a balance cannot be deleted (HTTP 400), so nothing
 * here funds one.
 */

const NAME_PREFIX = 'E2E';

describe.skipIf(!hasCredentials)('sub-accounts', () => {
  let singapay!: SingaPay;
  const created: string[] = [];

  /** Create, and register for cleanup before anything can throw. */
  async function createAccount(type: string): Promise<SingaPayResponse> {
    const response = await singapay.accounts.create({
      name: `${NAME_PREFIX} ${reference(type.slice(0, 3))}`,
      type,
    });
    const id = field(response, 'id');

    if (typeof id === 'string') {
      created.push(id);
    }

    return response;
  }

  beforeAll(async () => {
    singapay = await connectionThatCan((client) => client.accounts.list());
  });

  afterAll(async () => {
    for (const id of created) {
      try {
        await singapay.accounts.delete(id);
      } catch {
        // Already gone, or holding a balance. Not worth failing the run over.
      }
    }
  });

  it('creates, finds, renames, deactivates and deletes an owned account', async () => {
    const account = await createAccount('owned');

    expect(account.successful).toBe(true);

    const id = field(account, 'id') as string;

    // `owned` needs no KYB, so it is usable immediately.
    expect(field(account, 'status')).toBe('active');

    await expect(singapay.accounts.find(id)).resolves.toMatchObject({ successful: true });

    await expect(
      singapay.accounts.update(id, { name: `${NAME_PREFIX} ${reference('ren')}` }),
    ).resolves.toMatchObject({ successful: true });

    // `update/{id}` accepts a status change, despite the OpenAPI spec claiming
    // a separate `update-status/{id}` route is required for it.
    await expect(singapay.accounts.updateStatus(id, 'inactive')).resolves.toMatchObject({
      successful: true,
    });

    // DELETE is absent from merchant-api.json but works. Do not drop it on
    // the strength of the spec alone.
    await expect(singapay.accounts.delete(id)).resolves.toMatchObject({ successful: true });
  });

  it('creates a business-managed account', async () => {
    const account = await createAccount('business_managed');

    expect(account.successful).toBe(true);

    // CHANGED since 2026-08-21, when this same call returned `inactive` with
    // `kyb_status: kyb_in_review` and a `kyb_onboarding_url`. As of
    // 2026-08-23 it comes back `active` with both KYB fields null — no review
    // gate at all. Pinned so that a swing back is noticed rather than assumed.
    expect(field(account, 'status')).toBe('active');
  });

  it('accepts the "partner" type', async () => {
    // Also CHANGED: refused 422 on 2026-08-21, accepted on 2026-08-23. The
    // type is in SingaPay's published enum, so acceptance is the reading that
    // matches their spec — but do not treat either behaviour as settled.
    const account = await createAccount('partner');

    expect(account.successful).toBe(true);
  });
});
