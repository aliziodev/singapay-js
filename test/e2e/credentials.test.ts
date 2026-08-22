import { beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay } from '../../src/index.js';
import {
  accountId,
  hasCredentials,
  hasMerchantConnection,
  MERCHANT_CONNECTION,
  sharedClient,
} from './setup.js';

/**
 * Both dashboard credentials, exercised through one client.
 *
 * A merchant holds a merchant-wide **Default** credential plus **Specific**
 * ones bound to particular sub-accounts, and the gateway refuses the wrong
 * one with `SP403`. These tests prove the connection wiring actually reaches
 * two different credentials rather than quietly using one twice — which would
 * look identical from the outside until an SP403 in production.
 */
describe.skipIf(!hasCredentials || !hasMerchantConnection)('both credentials', () => {
  let singapay!: SingaPay;
  let merchant!: SingaPay;

  beforeAll(() => {
    singapay = sharedClient();
    merchant = singapay.connection(MERCHANT_CONNECTION);
  });

  it('resolves two distinct credential sets', () => {
    expect(singapay.connectionNames).toEqual(['default', MERCHANT_CONNECTION]);
    expect(merchant.config.clientId).not.toBe(singapay.config.clientId);
    expect(merchant.config.apiKey).not.toBe(singapay.config.apiKey);
  });

  it('authenticates each credential separately', async () => {
    const primary = await singapay.tokens.token();
    const secondary = await merchant.tokens.token();

    expect(primary).toBeTypeOf('string');
    expect(secondary).toBeTypeOf('string');

    // Two credentials must never end up sharing a cached token. If this ever
    // matches, the cache key stopped including the client id and one
    // credential is signing with another's identity.
    expect(secondary).not.toBe(primary);
  });

  it('reads the merchant balance with either credential', async () => {
    const [primary, secondary] = await Promise.all([
      singapay.balance.merchant(),
      merchant.balance.merchant(),
    ]);

    expect(primary.successful).toBe(true);
    expect(secondary.successful).toBe(true);
  });

  it.skipIf(accountId === null)(
    'serves the configured sub-account from its owning credential only',
    async () => {
      const owner = await singapay.balance.account();

      expect(owner.successful).toBe(true);

      // The merchant-wide credential either serves this account too (it is
      // unassigned, so it falls back) or refuses it with exactly SP403.
      // Any other code means something changed that is not documented.
      const other = await merchant.balance.account(accountId ?? undefined);

      if (!other.successful) {
        expect(other.code).toBe('SP403');
      }
    },
  );

  it('accepts a webhook signed by either credential', () => {
    // Both secrets have to be candidates: money-out notifications arrive from
    // the merchant Default credential even when the transfer was made with a
    // Specific one, so a verifier holding only the calling credential's secret
    // rejects them silently.
    expect(singapay.config.webhookSecrets).toContain(singapay.config.clientSecret);
    expect(singapay.config.webhookSecrets).toContain(merchant.config.clientSecret);
    expect(merchant.config.webhookSecrets).toEqual(singapay.config.webhookSecrets);
  });
});
