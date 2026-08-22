import { WebhookVerificationError } from '../errors.js';

/** A web `Request`, or anything else exposing its body as `text()`. */
interface TextBody {
  text: () => Promise<string>;
}

/** A Node `IncomingMessage`, or any other stream of body chunks. */
type ChunkStream = AsyncIterable<Uint8Array | string>;

/** An event object that wraps one of the two above, the way h3 does. */
interface EventLike {
  request?: unknown;
  node?: { req?: unknown };
}

/**
 * Anything a server framework hands a handler that may still carry the
 * untouched request bytes.
 */
export type WebhookBodySource = TextBody | ChunkStream | EventLike;

function isTextBody(source: unknown): source is TextBody {
  if (source === null || typeof source !== 'object') {
    return false;
  }

  return typeof (source as Record<string, unknown>).text === 'function';
}

function isChunkStream(source: unknown): source is ChunkStream {
  if (source === null || typeof source !== 'object') {
    return false;
  }

  return typeof (source as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function';
}

/**
 * Drain a chunked stream into one string.
 *
 * Chunks are concatenated as bytes and decoded once at the end. Decoding each
 * chunk separately would corrupt any multi-byte character that happens to
 * straddle a chunk boundary — and a single mangled character changes the hash,
 * which fails the signature for reasons no log would explain.
 */
async function readStream(stream: ChunkStream): Promise<string> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;

  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;

    chunks.push(bytes);
    length += bytes.length;
  }

  const joined = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(joined);
}

async function readFrom(source: WebhookBodySource): Promise<string> {
  if (isTextBody(source)) {
    return source.text();
  }

  if (isChunkStream(source)) {
    return readStream(source);
  }

  const event = source as EventLike;

  if (isTextBody(event.request)) {
    return event.request.text();
  }

  const nodeRequest = event.node?.req;

  if (isChunkStream(nodeRequest)) {
    return readStream(nodeRequest);
  }

  throw new WebhookVerificationError(
    'Could not find the raw request body on this object. Pass the web `Request`, the Node request stream, or the framework event that wraps one of them.',
  );
}

/**
 * Read the untouched bytes of a request body, whatever your framework hands you.
 *
 * {@link verifyWebhook} hashes the canonical form of the payload first and the
 * verbatim bytes second, so a body that was parsed and re-serialized usually
 * still verifies — key order and whitespace are absorbed by normalization.
 * What normalization cannot undo is information the parse destroyed: an
 * integer past `Number.MAX_SAFE_INTEGER` comes back rounded, and the
 * verbatim-bytes fallback is gone. Reading the body first keeps both intact,
 * and costs nothing.
 *
 * The source is recognised structurally rather than by importing framework
 * types, so one build serves a web `Request` (Next.js App Router, Hono,
 * SvelteKit, Remix, Bun, Deno), a Node `IncomingMessage` (Express, Fastify),
 * and the event objects h3 v1 and v2 hand a Nitro handler — with no peer
 * dependency pinning any of their versions.
 *
 * ```ts
 * const rawBody = await readWebhookBody(request);
 *
 * const verified = await singapay.verifyWebhook(
 *   rawBody,
 *   request.headers,
 *   '/api/webhooks/singapay',
 * );
 * ```
 *
 * Under Nitro, h3's own auto-imported `readRawBody(event)` does the same job.
 * Use whichever reads better in your codebase; this one exists so the same
 * line works across every runtime.
 *
 * @throws {WebhookVerificationError} If the object carries no readable body,
 * or the body is empty because something already consumed the stream.
 */
export async function readWebhookBody(source: WebhookBodySource): Promise<string> {
  const rawBody = await readFrom(source);

  if (rawBody === '') {
    throw new WebhookVerificationError(
      'The request body was empty by the time it was read. A body parser that ran first (Express `body-parser`, Nitro, a framework default) consumes the stream and leaves nothing to verify — reach the raw body before anything parses it.',
    );
  }

  return rawBody;
}
