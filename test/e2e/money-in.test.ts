import { beforeAll, describe, expect, it } from 'vitest';
import type { SingaPay, SingaPayResponse } from '../../src/index.js';
import { ApiError } from '../../src/index.js';
import {
  accountId,
  connectionThatCan,
  field,
  firstRow,
  hasCredentials,
  reference,
} from './setup.js';

/**
 * Money-in against the sandbox.
 *
 * Nothing here needs the money-out guard: every call collects money rather
 * than moving it out. Each lifecycle creates, reads, and then deletes what it
 * made, so repeated runs do not silt the account up.
 *
 * Several tests deliberately pin gateway *behaviour* rather than just a 200,
 * because the behaviours below are not guessable from SingaPay's docs and each
 * one has a plausible-looking wrong reading that fails silently in production.
 */

/** ISO 8601, which payment links and QRIS want. */
function isoInADay(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}

/** Unix milliseconds as a 13-digit string, which virtual accounts want instead. */
function msInADay(): string {
  return String(Date.now() + 86_400_000);
}

describe.skipIf(!hasCredentials)('money-in', () => {
  let singapay!: SingaPay;

  beforeAll(async () => {
    // Probe with a read-only, account-scoped list: money-in permission is
    // granted separately from money-out, so the winner here need not be the
    // connection that may disburse.
    singapay = await connectionThatCan((client) => client.paymentLinks.list());

    process.stderr.write(`\n  money-in as connection "${singapay.config.connectionName}"\n\n`);
  });

  describe('account and ledger', () => {
    it('lists sub-accounts', async () => {
      await expect(singapay.accounts.list()).resolves.toMatchObject({ successful: true });
    });

    it.skipIf(accountId === null)('finds the configured sub-account', async () => {
      await expect(singapay.accounts.find(accountId ?? '')).resolves.toMatchObject({
        successful: true,
      });
    });

    it('reads the merchant balance', async () => {
      await expect(singapay.balance.merchant()).resolves.toMatchObject({ successful: true });
    });

    it('lists statements, and reads one back', async () => {
      const listed = await singapay.statements.list();

      expect(listed.successful).toBe(true);

      const row = firstRow(listed);

      if (row === null) {
        process.stderr.write('\n  no statement rows yet; statements.find skipped\n\n');

        return;
      }

      // `transaction_id`, not `id` — a statement row has no `id` at all.
      await expect(singapay.statements.find(String(row.transaction_id))).resolves.toMatchObject({
        successful: true,
      });
    });
  });

  describe('payment methods', () => {
    it('is the only authority on which codes exist', async () => {
      // Deliberately read from the gateway rather than frozen into an enum:
      // the list is per-merchant and grows as SingaPay adds channels.
      const response = await singapay.paymentLinks.paymentMethods();
      const methods = field(response, 'payment_methods');

      expect(response.successful).toBe(true);
      expect(Array.isArray(methods)).toBe(true);
      expect((methods as unknown[]).length).toBeGreaterThan(0);

      const rows = methods as { code?: unknown; group?: string }[];
      const groups = new Set(rows.map((method) => method.group ?? 'unknown'));

      // Recorded in sandbox 2026-08-21: card, ewallet, offline_store, qris, va.
      expect(groups).toContain('va');
      expect(groups).toContain('qris');

      // `code` is the field `whitelisted_payment_method` consumes, so its name
      // and type matter more than anything else on the row. Pinned after a
      // 2026-08-23 pull returned 20 rows shaped
      // `{ code, name, group, desc }`. The catalogue itself stays unpinned —
      // it is per-merchant and grows — but every row must carry a usable code.
      for (const row of rows) {
        expect(typeof row.code).toBe('string');
        expect(row.code).not.toBe('');
      }

      const codes = new Set(rows.map((row) => row.code));

      expect(codes).toContain('VA_BCA');
      expect(codes).toContain('QRIS');
    });
  });

  describe('payment links', () => {
    it('lists them', async () => {
      await expect(singapay.paymentLinks.list()).resolves.toMatchObject({ successful: true });
    });

    it('creates, finds, updates and deletes one', async () => {
      const created = await singapay.paymentLinks.create({
        reff_no: reference('E2E-PL'),
        payment_link_type: 'total',
        total_amount: 150_000,
        max_usage: 1,
        expired_at: isoInADay(),
      });

      expect(created.successful).toBe(true);

      const id = field(created, 'id');

      expect(typeof id).toBe('number');
      expect(field(created, 'payment_url')).toBeTypeOf('string');

      const found = await singapay.paymentLinks.find(id as number);

      expect(found.successful).toBe(true);

      const updated = await singapay.paymentLinks.update(id as number, { max_usage: 2 });

      expect(updated.successful).toBe(true);

      await expect(singapay.paymentLinks.delete(id as number)).resolves.toMatchObject({
        successful: true,
      });
    });

    it('lets the gateway total an itemised link, discounts included', async () => {
      const created = await singapay.paymentLinks.create({
        reff_no: reference('E2E-PLI'),
        payment_link_type: 'items',
        items: [
          { name: 'Produk A', quantity: 2, unit_price: 25_000 },
          { name: 'Diskon', quantity: 1, unit_price: -5_000 },
        ],
        expired_at: isoInADay(),
      });

      expect(created.successful).toBe(true);

      await singapay.paymentLinks.delete(field(created, 'id') as number);
    });

    it('treats an empty whitelist as EVERY method, not as none', async () => {
      // The trap: `[]` reads like "no methods allowed" and means the opposite.
      // Anyone using it to lock a link down would silently open it up instead.
      const created = await singapay.paymentLinks.create({
        reff_no: reference('E2E-PLW'),
        payment_link_type: 'total',
        total_amount: 50_000,
        whitelisted_payment_method: [],
        expired_at: isoInADay(),
      });

      expect(created.successful).toBe(true);

      const whitelisted = field(created, 'whitelisted_payment_method');

      expect(Array.isArray(whitelisted)).toBe(true);
      expect((whitelisted as unknown[]).length).toBeGreaterThan(1);

      await singapay.paymentLinks.delete(field(created, 'id') as number);
    });

    it('rejects the whole request over one bad method code', async () => {
      // Not a partial success and not a silent drop — the entire link fails.
      await expect(
        singapay.paymentLinks.create({
          reff_no: reference('E2E-PLX'),
          payment_link_type: 'total',
          total_amount: 50_000,
          whitelisted_payment_method: ['VA_BCA', 'NOT_A_REAL_METHOD'],
          expired_at: isoInADay(),
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it('treats method codes as case sensitive', async () => {
      await expect(
        singapay.paymentLinks.create({
          reff_no: reference('E2E-PLC'),
          payment_link_type: 'total',
          total_amount: 50_000,
          whitelisted_payment_method: ['va_bca'],
          expired_at: isoInADay(),
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it('lists histories, and reads one back', async () => {
      const listed = await singapay.paymentLinkHistories.list();

      expect(listed.successful).toBe(true);

      const row = firstRow(listed);

      if (row === null) {
        process.stderr.write('\n  no payment-link history yet; find skipped\n\n');

        return;
      }

      await expect(singapay.paymentLinkHistories.find(Number(row.id))).resolves.toMatchObject({
        successful: true,
      });
    });
  });

  describe('virtual accounts', () => {
    it('creates, finds and deletes a temporary VA', async () => {
      const created = await singapay.virtualAccounts.create({
        bank_code: 'BRI',
        kind: 'temporary',
        amount_type: 'closed',
        amount: 100_000,
        expired_at: msInADay(),
        max_usage: 1,
        merchant_reff_no: reference('E2E-VA'),
      });

      expect(created.successful).toBe(true);
      expect(field(created, 'number')).toBeTypeOf('string');

      const id = field(created, 'id');

      expect(id).toBeTypeOf('string');

      const found = await singapay.virtualAccounts.find(id as string);

      expect(found.successful).toBe(true);

      // A VA never reports itself expired: `status` stays "active" and there is
      // no computed field at all, unlike payment links. Gating on `status`
      // would treat an expired VA as payable forever.
      expect(field(found, 'status_computed')).toBeUndefined();
      expect(field(found, 'is_expired')).toBeUndefined();

      // So the caller has to compare `expired_at` themselves — and it is Unix
      // MILLISECONDS here, while payment links and QRIS use ISO 8601.
      expect(String(field(found, 'expired_at'))).toMatch(/^\d{13}$/);

      await expect(singapay.virtualAccounts.delete(id as string)).resolves.toMatchObject({
        successful: true,
      });
    });

    it('updates a temporary VA in place', async () => {
      const created = await singapay.virtualAccounts.create({
        bank_code: 'BRI',
        kind: 'temporary',
        amount_type: 'closed',
        amount: 100_000,
        expired_at: msInADay(),
        max_usage: 1,
        merchant_reff_no: reference('E2E-VAU'),
      });

      const id = field(created, 'id') as string;

      try {
        // A full replace, not a partial patch: omitting `status`, `expired_at`
        // or `max_usage` is refused 422 even though they are unchanged. Send
        // the whole object, or the update reads as a validation bug.
        await expect(
          singapay.virtualAccounts.update(id, {
            status: 'active',
            amount_type: 'closed',
            amount: 125_000,
            expired_at: msInADay(),
            max_usage: 1,
          }),
        ).resolves.toMatchObject({ successful: true });
      } finally {
        await singapay.virtualAccounts.delete(id).catch(() => undefined);
      }
    });

    it('lists virtual accounts and their transactions', async () => {
      await expect(singapay.virtualAccounts.list()).resolves.toMatchObject({ successful: true });

      const transactions = await singapay.vaTransactions.list();

      expect(transactions.successful).toBe(true);

      const row = firstRow(transactions);

      if (row === null) {
        process.stderr.write('\n  no VA transactions yet; find and listByVaNumber skipped\n\n');

        return;
      }

      // `transaction_id`, not `id`. These listings key on the gateway's
      // transaction identifier; only some products carry an `id` as well.
      await expect(singapay.vaTransactions.find(String(row.transaction_id))).resolves.toMatchObject(
        { successful: true },
      );

      // Looking a VA up by the number the customer actually paid to, rather
      // than by an identifier only the merchant ever sees.
      await expect(
        singapay.vaTransactions.listByVaNumber(String(row.va_number)),
      ).resolves.toMatchObject({ successful: true });
    });
  });

  describe('qris', () => {
    it('generates a dynamic QR and reads it back', async () => {
      const generated = await singapay.qris.generate({
        amount: 50_000,
        // ISO 8601 here, unlike the milliseconds a VA wants.
        expired_at: isoInADay(),
        merchant_reff_no: reference('E2E-QR'),
      });

      expect(generated.successful).toBe(true);

      const listed = await singapay.qris.list();

      expect(listed.successful).toBe(true);

      const id = field(generated, 'id');

      if (typeof id === 'number') {
        await expect(singapay.qris.find(id)).resolves.toMatchObject({ successful: true });
      }
    });
  });

  describe('e-wallet', () => {
    it('creates a DANA order carrying a checkout URL', async () => {
      const order = await singapay.ewallet.createOrder({
        amount: 75_000,
        ewallet_vendor: 'EWALLET_DANA',
        merchant_reff_no: reference('E2E-EW'),
      });

      expect(order.successful).toBe(true);
      expect(field(order, 'checkout_url')).toBeTypeOf('string');
    });

    it('refuses an OVO order with no customer phone', async () => {
      // OVO is push-to-pay: there is nowhere to redirect, so the phone number
      // is the only way to reach the customer and the gateway insists on it.
      await expect(
        singapay.ewallet.createOrder({
          amount: 75_000,
          ewallet_vendor: 'EWALLET_OVO',
          merchant_reff_no: reference('E2E-OVO'),
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it('still serves the legacy v1 checkout endpoint', async () => {
      // Marked "Create v1 (Legacy)" in SingaPay's own navigation. Kept
      // exercised because legacy does not mean removed, and an integration
      // built on it should learn from a test rather than from production.
      const checkout = await singapay.ewallet.createCheckout({
        amount: 75_000,
        ewallet_vendor: 'EWALLET_DANA',
        merchant_reff_no: reference('E2E-EWL'),
      });

      expect(checkout.successful).toBe(true);
    });

    it('lists e-wallet transactions, and reads one back', async () => {
      const listed = await singapay.ewallet.listTransactions();

      expect(listed.successful).toBe(true);

      const row = firstRow(listed);

      if (row === null) {
        process.stderr.write('\n  no e-wallet transactions yet; find and inquiry skipped\n\n');

        return;
      }

      await expect(singapay.ewallet.findTransaction(Number(row.id))).resolves.toMatchObject({
        successful: true,
      });

      // The only way to learn a checkout failed: a failed one emits no
      // webhook at all, so polling this is the whole discovery mechanism.
      await expect(singapay.ewallet.inquireStatus(Number(row.id))).resolves.toMatchObject({
        successful: true,
      });
    });
  });
});
