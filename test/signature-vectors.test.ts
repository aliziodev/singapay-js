import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RequestSigner } from '../src/auth/request-signer.js';
import { hashJson, normalizeJson } from '../src/normalize/json-normalizer.js';

/**
 * The canonicalization oracle.
 *
 * SingaPay publishes no specification for how a request body is serialized
 * before it is signed; the rules had to be worked out from the behaviour of
 * the gateway and its official sample code. Each vector pins one of them —
 * byte-order key sorting, empty objects, unescaped unicode and slashes — with
 * the canonical bytes, the hash, and the expected signature.
 *
 * If a vector fails here, the normalizer is wrong. Never edit the fixture to
 * make it pass: that turns a signature that the gateway will reject into a
 * test suite that says everything is fine.
 */
type Vector = {
  name: string;
  description: string;
  payload: unknown;
  normalized_json: string;
  hashed_body: string;
  expected_signature: string;
};

type Fixture = {
  secret: string;
  access_token: string;
  method: string;
  endpoint: string;
  timestamp: number;
  vectors: Vector[];
};

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/signature-vectors.json', import.meta.url)),
    'utf8',
  ),
) as Fixture;

const signer = new RequestSigner();

describe('shared signature vectors', () => {
  it('covers every vector in the fixture', () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
  });

  for (const vector of fixture.vectors) {
    describe(vector.name, () => {
      it(`normalizes to the canonical JSON (${vector.description})`, () => {
        expect(normalizeJson(vector.payload)).toBe(vector.normalized_json);
      });

      it('hashes the canonical JSON', async () => {
        await expect(hashJson(vector.payload)).resolves.toBe(vector.hashed_body);
      });

      it('produces the expected signature', async () => {
        const signature = await signer.sign(
          fixture.method,
          fixture.endpoint,
          fixture.access_token,
          vector.payload,
          fixture.timestamp,
          fixture.secret,
        );

        expect(signature).toBe(vector.expected_signature);
      });
    });
  }
});
