import { beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay } from '../../src/index.js';
import { IpNotWhitelistedError } from '../../src/index.js';
import { accountId, hasCredentials, sharedClient } from './setup.js';

/**
 * The first thing to run, and the only thing worth running until it passes.
 *
 * Every later call rides on what this proves: the credentials are real, this
 * machine's IP is whitelisted, the v1.1 token exchange signs correctly, and
 * the envelope parser understands what comes back. A failure here explains
 * every other failure in the suite, so the rest is not worth reading first.
 */
describe.skipIf(!hasCredentials)('gateway connectivity', () => {
  let singapay!: SingaPay;

  beforeAll(() => {
    singapay = sharedClient();
  });

  it('exchanges an access token', async () => {
    try {
      const token = await singapay.tokens.token();

      expect(token).toBeTypeOf('string');
      expect(token.length).toBeGreaterThan(0);
    } catch (error) {
      if (error instanceof IpNotWhitelistedError) {
        throw new Error(
          "SP017: this machine's public IP is not whitelisted in the SingaPay dashboard. " +
            'Nothing else in this suite can pass until it is. Add the egress IP under the ' +
            'credential, and remember a VPN or a changed home IP invalidates it.',
          { cause: error },
        );
      }

      throw error;
    }
  });

  it('caches the token rather than re-fetching it', async () => {
    const first = await singapay.tokens.token();
    const second = await singapay.tokens.token();

    expect(second).toBe(first);
  });

  it('reads the merchant balance', async () => {
    const response = await singapay.balance.merchant();

    expect(response.successful).toBe(true);
    expect(response.status).toBe(200);
    expect(response.data).toBeTypeOf('object');
  });

  it('lists sub-accounts', async () => {
    const response = await singapay.accounts.list();

    expect(response.successful).toBe(true);
    expect(response.raw).toBeTypeOf('object');
  });

  it.skipIf(accountId === null)('reads the configured sub-account balance', async () => {
    const response = await singapay.balance.account();

    // SP403 here means the configured account belongs to a different
    // credential — the account is fine, the credential is the wrong one.
    expect(response.code).not.toBe('SP403');
    expect(response.successful).toBe(true);
  });
});
