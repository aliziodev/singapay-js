import { describe, expect, it } from 'vitest';
import { parseEnvelope } from '../src/http/response.js';

/**
 * Envelope normalization.
 *
 * The gateway answers in more than one shape depending on the endpoint's
 * generation, and the whole SDK depends on those collapsing into one. Two
 * production bugs on the Laravel sibling came from misreading an envelope, so
 * each shape is pinned here rather than assumed.
 */
describe('parseEnvelope', () => {
  describe('v2 — response_code', () => {
    it('reads a single record', () => {
      const response = parseEnvelope(200, {
        response_code: 'SP000',
        response_message: 'OK',
        data: { payment_url: 'https://pay.test/abc' },
      });

      expect(response.successful).toBe(true);
      expect(response.code).toBe('SP000');
      expect(response.message).toBe('OK');
      expect(response.data.payment_url).toBe('https://pay.test/abc');
      expect(response.items).toBeNull();
    });

    it('treats any code other than SP000 as a failure', () => {
      const response = parseEnvelope(200, {
        response_code: 'SP017',
        response_message: 'IP not whitelisted',
      });

      expect(response.successful).toBe(false);
      expect(response.code).toBe('SP017');
    });
  });

  describe('v1 — success flag', () => {
    it('reads a single record', () => {
      const response = parseEnvelope(200, {
        status: 200,
        success: true,
        data: { id: 'acc-1' },
      });

      expect(response.successful).toBe(true);
      expect(response.data.id).toBe('acc-1');
    });

    it('surfaces a field error carried under `error`', () => {
      const response = parseEnvelope(422, {
        success: false,
        error: { code: 'SP018', message: 'Validation error' },
      });

      expect(response.successful).toBe(false);
      expect(response.code).toBe('SP018');
      expect(response.message).toBe('Validation error');
    });
  });

  describe('list payloads', () => {
    it('keeps the rows instead of dropping them', () => {
      // Regression: `data` used to become `{}` for every `list()` endpoint,
      // because the record cast rejected arrays. A caller reading `data` saw
      // an empty object and would reasonably conclude there were no records.
      const rows = [{ id: 'a' }, { id: 'b' }];
      const response = parseEnvelope(200, { status: 200, success: true, data: rows });

      expect(response.items).toEqual(rows);
      expect(response.successful).toBe(true);
    });

    it('leaves `data` an object so a single-record read stays type-safe', () => {
      const response = parseEnvelope(200, { status: 200, success: true, data: [{ id: 'a' }] });

      expect(response.data).toEqual({});
      expect(Array.isArray(response.items)).toBe(true);
    });

    it('handles a bare array body, with no envelope around it', () => {
      const response = parseEnvelope(200, [{ id: 'a' }]);

      expect(response.items).toEqual([{ id: 'a' }]);
      expect(response.data).toEqual({});
    });

    it('reports an empty list as empty rather than as absent', () => {
      const response = parseEnvelope(200, { status: 200, success: true, data: [] });

      expect(response.items).toEqual([]);
      expect(response.items).not.toBeNull();
    });
  });

  describe('flat payloads', () => {
    it('treats the whole body as the data when there is no envelope', () => {
      const response = parseEnvelope(200, { access_token: 'token-123', expires_in: '900' });

      expect(response.data.access_token).toBe('token-123');
      expect(response.successful).toBe(true);
      expect(response.items).toBeNull();
    });

    it('fails a flat payload on a non-2xx status', () => {
      const response = parseEnvelope(500, { message: 'Internal Server Error' });

      expect(response.successful).toBe(false);
      expect(response.message).toBe('Internal Server Error');
    });
  });

  describe('unparseable bodies', () => {
    it('does not pretend a string body is a record', () => {
      const response = parseEnvelope(502, 'Bad Gateway');

      expect(response.data).toEqual({});
      expect(response.items).toBeNull();
      expect(response.successful).toBe(false);
      expect(response.raw).toBe('Bad Gateway');
    });

    it('keeps a null body from being read as success', () => {
      const response = parseEnvelope(204, null);

      expect(response.data).toEqual({});
      expect(response.successful).toBe(true);
    });
  });
});
