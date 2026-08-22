import { describe, expect, it } from 'vitest';
import { AccessTokenSigner } from '../src/auth/access-token-signer.js';
import { JakartaClock } from '../src/clock.js';

function frozenAt(iso: string): JakartaClock {
  return new JakartaClock(() => new Date(iso));
}

describe('JakartaClock', () => {
  it('uses the Jakarta calendar day, not the UTC one', () => {
    // 03:00 WIB on 22 August is still 20:00 UTC on 21 August. The official
    // Node.js example signs with the UTC date here and gets rejected; every
    // request between 00:00 and 07:00 WIB would fail.
    expect(frozenAt('2026-08-21T20:00:00Z').signatureDate()).toBe('20260822');
  });

  it('agrees with UTC once past 07:00 WIB', () => {
    expect(frozenAt('2026-08-22T03:00:00Z').signatureDate()).toBe('20260822');
  });

  it('reports whole Unix seconds', () => {
    expect(frozenAt('2026-08-20T00:00:00.750Z').unixSeconds()).toBe(1787184000);
  });

  it('reports 13-digit milliseconds', () => {
    expect(String(frozenAt('2026-08-20T00:00:00Z').unixMilliseconds())).toHaveLength(13);
  });
});

describe('AccessTokenSigner', () => {
  it('signs client_id_client_secret_YYYYMMDD with the Jakarta date', async () => {
    const signer = new AccessTokenSigner(frozenAt('2026-08-21T20:00:00Z'));

    expect(signer.payload('client-abc', 'secret-xyz')).toBe('client-abc_secret-xyz_20260822');

    const signature = await signer.sign('client-abc', 'secret-xyz');

    expect(signature).toMatch(/^[0-9a-f]{128}$/);
  });
});
