import { describe, expect, it } from 'vitest';
import { WebhookVerificationError } from '../src/errors.js';
import { normalizeWebhookBody, verifyWebhook } from '../src/webhooks/verify.js';

/**
 * Hostile inbound bodies.
 *
 * A webhook endpoint is a public URL. Anyone who learns it can post anything
 * to it, and the body is parsed and canonicalized **before** the signature is
 * checked — there is no way around that, since the signature covers the
 * canonical form. So every failure on that path has to arrive as a
 * {@link WebhookVerificationError} the caller already handles, never as some
 * runtime error that escapes to the framework as a 500.
 */

/**
 * A body nested `depth` levels deep.
 *
 * Assembled as a string rather than with `JSON.stringify`, which is itself
 * recursive and overflows before it can emit a hostile payload. An attacker
 * has the same freedom: nothing about this is hard to produce.
 */
function nested(depth: number): string {
  return `${'{"a":'.repeat(depth)}{}${'}'.repeat(depth)}`;
}

function headers() {
  return {
    signature: 'a'.repeat(128),
    timestamp: String(Math.floor(Date.now() / 1000)),
    authorization: 'Bearer gateway-token',
  };
}

describe('hostile webhook bodies', () => {
  it('rejects nesting past the ceiling rather than exhausting the stack', () => {
    // Regression: this raised `RangeError: Maximum call stack size exceeded`,
    // which no caller catches, from an endpoint an attacker reaches without
    // any credential at all.
    expect(() => normalizeWebhookBody(JSON.parse(nested(200)))).toThrow(WebhookVerificationError);
  });

  it('still accepts nesting a real delivery could plausibly use', () => {
    expect(() => normalizeWebhookBody(JSON.parse(nested(8)))).not.toThrow();
  });

  it('never lets a hostile body escape as an undocumented error type', async () => {
    await expect(
      verifyWebhook({
        rawBody: nested(50_000),
        headers: headers(),
        endpoint: '/api/webhooks/singapay',
        secrets: 'secret',
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a body that is not JSON at all', async () => {
    await expect(
      verifyWebhook({
        rawBody: 'not json',
        headers: headers(),
        endpoint: '/api/webhooks/singapay',
        secrets: 'secret',
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a JSON body that is not an object', async () => {
    await expect(
      verifyWebhook({
        rawBody: '"a bare string"',
        headers: headers(),
        endpoint: '/api/webhooks/singapay',
        secrets: 'secret',
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a stale timestamp before it parses anything', async () => {
    // Replay protection runs first, so a body that would be expensive to
    // canonicalize is never canonicalized when the delivery is already stale.
    await expect(
      verifyWebhook({
        rawBody: nested(50_000),
        headers: { ...headers(), timestamp: '1000000000' },
        endpoint: '/api/webhooks/singapay',
        secrets: 'secret',
      }),
    ).rejects.toThrow(/timestamp/i);
  });

  it('rejects a timestamp that is not a Unix timestamp', async () => {
    await expect(
      verifyWebhook({
        rawBody: '{}',
        headers: { ...headers(), timestamp: 'not-a-number' },
        endpoint: '/api/webhooks/singapay',
        secrets: 'secret',
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a delivery missing its headers', async () => {
    await expect(
      verifyWebhook({
        rawBody: '{}',
        headers: {},
        endpoint: '/api/webhooks/singapay',
        secrets: 'secret',
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('refuses to verify when no secret is configured', async () => {
    // Otherwise an empty candidate list would loop zero times and fall through
    // to the generic mismatch, hiding a misconfiguration as a bad signature.
    await expect(
      verifyWebhook({
        rawBody: '{}',
        headers: headers(),
        endpoint: '/api/webhooks/singapay',
        secrets: [],
      }),
    ).rejects.toThrow(/no webhook secret/i);
  });
});
