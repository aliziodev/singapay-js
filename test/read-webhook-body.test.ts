import { describe, expect, it } from 'vitest';
import { RequestSigner } from '../src/auth/request-signer.js';
import { sha256Hex } from '../src/crypto.js';
import { WebhookVerificationError } from '../src/errors.js';
import { readWebhookBody } from '../src/webhooks/read-webhook-body.js';
import { normalizeWebhookBody, verifyWebhook } from '../src/webhooks/verify.js';

const SECRET = 'singapay-test-secret';
const ENDPOINT = '/api/webhooks/singapay';
const TOKEN = 'gateway-generated-token';

/** A stream that yields the given chunks, the way a real request arrives. */
function stream(...chunks: (Uint8Array | string)[]): AsyncIterable<Uint8Array | string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function webRequest(rawBody: string): Request {
  return new Request(`https://merchant.test${ENDPOINT}`, { method: 'POST', body: rawBody });
}

describe('readWebhookBody', () => {
  it('reads a web Request', async () => {
    await expect(readWebhookBody(webRequest('{"event":"va-transaction"}'))).resolves.toBe(
      '{"event":"va-transaction"}',
    );
  });

  it('reads a bare Node request stream', async () => {
    await expect(readWebhookBody(stream('{"event":', '"disbursement"}'))).resolves.toBe(
      '{"event":"disbursement"}',
    );
  });

  it('reads an event that wraps a web Request, the way h3 v2 does', async () => {
    await expect(readWebhookBody({ request: webRequest('{"a":1}') })).resolves.toBe('{"a":1}');
  });

  it('reads an event that wraps a Node request stream, the way h3 v1 does', async () => {
    await expect(readWebhookBody({ node: { req: stream('{"a":', '1}') } })).resolves.toBe(
      '{"a":1}',
    );
  });

  it('decodes a multi-byte character split across a chunk boundary', async () => {
    // "Rp" + an em dash, whose UTF-8 bytes are deliberately torn in half.
    const bytes = new TextEncoder().encode('{"note":"Rp—150.000"}');
    const split = 12;

    await expect(readWebhookBody(stream(bytes.slice(0, split), bytes.slice(split)))).resolves.toBe(
      '{"note":"Rp—150.000"}',
    );
  });

  it('rejects an empty body, the trace a body parser leaves behind', async () => {
    await expect(readWebhookBody(stream())).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects an object carrying no readable body', async () => {
    await expect(readWebhookBody({ node: { req: { url: ENDPOINT } } })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });
});

describe('readWebhookBody feeding verifyWebhook', () => {
  /** Sign a payload the way the gateway does, then deliver it as a request. */
  async function delivery(payload: unknown): Promise<Request> {
    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await new RequestSigner().signHashedBody(
      'POST',
      ENDPOINT,
      TOKEN,
      await sha256Hex(normalizeWebhookBody(payload)),
      timestamp,
      SECRET,
    );

    return new Request(`https://merchant.test${ENDPOINT}`, {
      method: 'POST',
      body: rawBody,
      headers: {
        'X-Signature': signature,
        'X-Timestamp': String(timestamp),
        Authorization: `Bearer ${TOKEN}`,
      },
    });
  }

  it('verifies a genuine delivery end to end', async () => {
    const request = await delivery({ event: 'va-transaction' });

    const verified = await verifyWebhook({
      rawBody: await readWebhookBody(request),
      headers: request.headers,
      endpoint: ENDPOINT,
      secrets: SECRET,
    });

    expect(verified.type).toBe('va-transaction');
  });

  it('tolerates a re-serialized body, because the hash is taken over the canonical form', async () => {
    const request = await delivery({ event: 'va-transaction', amount: 150_000 });

    // What a framework hands back after it parses: same data, different bytes.
    const reserialized = JSON.stringify(
      JSON.parse(await readWebhookBody(request.clone())),
      null,
      2,
    );

    const verified = await verifyWebhook({
      rawBody: reserialized,
      headers: request.headers,
      endpoint: ENDPOINT,
      secrets: SECRET,
    });

    expect(verified.type).toBe('va-transaction');
  });

  it('rejects a body whose data actually differs', async () => {
    const request = await delivery({ event: 'va-transaction', amount: 150_000 });
    const tampered = JSON.stringify({ event: 'va-transaction', amount: 1_500_000 });

    await expect(
      verifyWebhook({
        rawBody: tampered,
        headers: request.headers,
        endpoint: ENDPOINT,
        secrets: SECRET,
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});
