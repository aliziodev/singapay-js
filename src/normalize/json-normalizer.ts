import { compareUtf8, sha256Hex } from '../crypto.js';
import { JsonNormalizationError } from '../errors.js';

/**
 * Canonical JSON serializer for SingaPay signature payloads.
 *
 * This is the most signature-critical component in the SDK: the request
 * signature hashes the serialized body, so the SDK and the gateway must agree
 * on every byte. The canonical form is:
 *
 * - Object keys sorted recursively in UTF-8 byte order.
 * - Arrays keep their order; elements are normalized recursively.
 * - No whitespace, no escaped slashes, no escaped unicode.
 * - Non-integer numbers are rejected outright — a whole float serializes
 *   differently across runtimes and would silently break signatures.
 *
 * The output is assembled by hand rather than handed to `JSON.stringify`,
 * because JavaScript objects enumerate integer-like keys numerically ahead of
 * string keys. A payload with the keys `"2"`, `"10"` and `"a"` would come back
 * in the wrong order, and the signature with it.
 *
 * Behaviour is pinned by `test/fixtures/signature-vectors.json`, which stores
 * the canonical bytes, hash and signature for every case these rules had to be
 * worked out from. Never relax one of them to make a test pass.
 */

/** A value that can appear in a request body. */
export type JsonBody = Record<string, unknown>;

const PLAIN_OBJECT_PROTOTYPES: ReadonlyArray<unknown> = [Object.prototype, null];

function isPlainObject(value: object): boolean {
  return PLAIN_OBJECT_PROTOTYPES.includes(Object.getPrototypeOf(value));
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'string':
      return JSON.stringify(value);

    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new JsonNormalizationError(
          `Non-integer number at ${path}. SingaPay amounts must be whole integers; a float would serialize differently across runtimes and break the signature.`,
        );
      }

      return String(value);

    case 'bigint':
      throw new JsonNormalizationError(
        `BigInt at ${path} cannot be represented in JSON. Pass a safe integer instead.`,
      );

    case 'undefined':
      throw new JsonNormalizationError(
        `Undefined at ${path}. Inside an array it would silently become null and change the signature.`,
      );

    case 'object':
      break;

    default:
      throw new JsonNormalizationError(`Unsupported type ${typeof value} at ${path}.`);
  }

  const object = value as object;

  if (hasToJson(object)) {
    return serialize(object.toJSON(), path);
  }

  if (Array.isArray(object)) {
    return `[${object.map((item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`;
  }

  if (!isPlainObject(object)) {
    throw new JsonNormalizationError(
      `Unsupported value at ${path}: only plain objects, arrays, and primitives can be signed. Convert ${object.constructor?.name ?? 'the value'} to a plain value first.`,
    );
  }

  const entries = Object.entries(object as Record<string, unknown>)
    // A key whose value is undefined is never sent, so it must not be hashed
    // either. Dropping it here keeps the wire body and the signature in step.
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareUtf8(left, right));

  const members = entries.map(
    ([key, item]) => `${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`,
  );

  return `{${members.join(',')}}`;
}

/**
 * Serialize a value into its canonical, signature-ready JSON form.
 *
 * @throws {JsonNormalizationError} When the value contains something that cannot be signed.
 */
export function normalizeJson(value: unknown): string {
  return serialize(value, '$');
}

/** SHA-256 of the canonical JSON, as lowercase hex. */
export async function hashJson(value: unknown): Promise<string> {
  return sha256Hex(normalizeJson(value));
}
