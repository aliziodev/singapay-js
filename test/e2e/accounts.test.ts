import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay, SingaPayResponse } from '../../src/index.js';
import { ApiError } from '../../src/index.js';
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

  /**
   * Create, and register for cleanup before anything can throw.
   *
   * The field is `account_type`, not `type`. A wrong name is **silently
   * ignored** — the account is created with no type at all and every
   * type-specific behaviour disappears, so assertions written against `type`
   * pass while proving nothing.
   */
  async function createAccount(accountType: string): Promise<SingaPayResponse> {
    const response = await singapay.accounts.create({
      name: `${NAME_PREFIX} ${reference(accountType.slice(0, 3))}`,
      account_type: accountType,
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
    expect(field(account, 'account_type')).toBe('owned');
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

  it('creates a business-managed account inactive, pending KYB', async () => {
    // Unlike `owned`, this one is not usable on creation: it waits on a KYB
    // review and carries an onboarding URL for the customer to complete.
    const account = await createAccount('business_managed');

    expect(account.successful).toBe(true);
    expect(field(account, 'account_type')).toBe('business_managed');
    expect(field(account, 'status')).toBe('inactive');
    expect(field(account, 'kyb_status')).toBe('kyb_in_review');
    expect(field(account, 'kyb_onboarding_url')).toBeTypeOf('string');
  });

  it('refuses the "partner" type the spec enum advertises', async () => {
    // Listed in SingaPay's own `Account` schema enum, refused by the create
    // endpoint. Do not offer it.
    await expect(
      singapay.accounts.create({ name: `${NAME_PREFIX} ptr`, account_type: 'partner' }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
