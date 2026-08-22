/**
 * The handful of primitives every SingaPay signature is built from.
 *
 * Implemented on the Web Crypto API (`crypto.subtle`) rather than
 * `node:crypto`, so identical bytes come out on Node, Bun, Deno and edge
 * runtimes without a runtime dependency or a conditional import.
 */

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto;

  if (!webcrypto?.subtle) {
    throw new Error(
      'Web Crypto API is unavailable. @aliziodev/singapay requires Node 20+, Bun, Deno, or an edge runtime.',
    );
  }

  return webcrypto.subtle;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }

  return hex;
}

/** HMAC-SHA512 as lowercase hex — the digest every SingaPay signature uses. */
export async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const key = await subtle().importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );

  return toHex(await subtle().sign('HMAC', key, encoder.encode(message)));
}

/** SHA-256 as lowercase hex — used for the hashed request body. */
export async function sha256Hex(message: string): Promise<string> {
  return toHex(await subtle().digest('SHA-256', encoder.encode(message)));
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Both inputs are fixed-length hex strings, so returning early on a length
 * mismatch leaks nothing an attacker does not already know.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return difference === 0;
}

/**
 * Byte-order (UTF-8) string comparison, matching the PHP `SORT_STRING` flag.
 *
 * The default JavaScript sort compares UTF-16 code units, which orders some
 * non-ASCII keys differently from UTF-8 bytes. Object keys feed straight into
 * a signature, so the comparison has to be the byte one.
 */
export function compareUtf8(a: string, b: string): number {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const shared = Math.min(left.length, right.length);

  for (let index = 0; index < shared; index++) {
    const difference = (left[index] as number) - (right[index] as number);

    if (difference !== 0) {
      return difference;
    }
  }

  return left.length - right.length;
}
