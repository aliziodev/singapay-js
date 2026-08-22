import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConnectionOptions, SingaPayResponse } from '../../src/index.js';
import { ApiError, SingaPay } from '../../src/index.js';

/**
 * Load a local `.env` into `process.env`, when there is one.
 *
 * A dozen lines rather than a dependency: these tests are the only thing in
 * the repo that needs it, and a package that advertises zero runtime
 * dependencies should not grow a dev one for this. A variable already present
 * in the real environment always wins, so CI and shell exports override the
 * file rather than the other way round.
 */
function loadDotEnv(): void {
  let contents: string;

  try {
    contents = readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8');
  } catch {
    return;
  }

  const parsed = new Map<string, string>();

  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);

    if (match === null) {
      continue;
    }

    const key = match[1];
    const value = match[2]?.trim().replace(/^["']|["']$/g, '');

    // A blank value counts as absent rather than as an empty string, so the
    // placeholder rows copied from .env.example never claim a name.
    if (key === undefined || value === undefined || value === '') {
      continue;
    }

    // The last row for a key wins, the way every .env reader behaves. That is
    // what makes "append your real values to the bottom" work instead of
    // silently losing to a placeholder further up.
    parsed.set(key, value);
  }

  for (const [key, value] of parsed) {
    // The real environment still outranks the file, so CI and shell exports
    // override it rather than the other way round.
    if ((process.env[key] ?? '') !== '') {
      continue;
    }

    process.env[key] = value;
  }
}

loadDotEnv();

function env(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name] ?? '';

    if (value !== '') {
      return value;
    }
  }

  return '';
}

/** Each credential, with every spelling accepted for it. */
const REQUIRED = [
  ['SINGAPAY_CLIENT_ID'],
  ['SINGAPAY_CLIENT_SECRET'],
  ['SINGAPAY_API_KEY', 'SINGAPAY_PARTNER_ID'],
] as const;

/** Credentials the run is missing; empty when it can talk to the gateway. */
export const missingCredentials = REQUIRED.filter((names) => env(...names) === '').map(
  (names) => names[0],
);

/** Whether this run can reach the gateway at all. */
export const hasCredentials = missingCredentials.length === 0;

/**
 * The name the second credential set is registered under.
 *
 * Not `default` — that name already belongs to the top-level credentials, so
 * calling the merchant-wide one `default` here would collide with the SDK's
 * own vocabulary and read as though it were the primary.
 */
export const MERCHANT_CONNECTION = 'merchant';

/**
 * The merchant-wide credential, when one is configured.
 *
 * Accepts the `SINGAPAY_DEFAULT_*` spelling too, because that is what the
 * Laravel app's `.env` already calls it — one less thing to retype, and one
 * less chance of pasting a secret into the wrong slot.
 */
const merchantCredentials: ConnectionOptions | null = (() => {
  const clientId = env('SINGAPAY_MERCHANT_CLIENT_ID', 'SINGAPAY_DEFAULT_CLIENT_ID');
  const clientSecret = env('SINGAPAY_MERCHANT_CLIENT_SECRET', 'SINGAPAY_DEFAULT_CLIENT_SECRET');
  const apiKey = env(
    'SINGAPAY_MERCHANT_API_KEY',
    'SINGAPAY_MERCHANT_PARTNER_ID',
    'SINGAPAY_DEFAULT_API_KEY',
    'SINGAPAY_DEFAULT_PARTNER_ID',
  );

  if (clientId === '' || clientSecret === '' || apiKey === '') {
    return null;
  }

  // The same sub-account, deliberately. `accountId` is per connection and is
  // never inherited from the top level — right in general, since each
  // credential serves its own accounts — but here both credentials are aimed
  // at one account precisely to discover which of them the gateway will let
  // operate on it.
  const sameAccount = process.env.SINGAPAY_ACCOUNT_ID ?? '';

  return {
    clientId,
    clientSecret,
    apiKey,
    ...(sameAccount === '' ? {} : { accountId: sameAccount }),
  };
})();

/** Whether a second credential set is available to exercise. */
export const hasMerchantConnection = merchantCredentials !== null;

/**
 * Every HMAC Validation Key configured, across both dashboard tabs.
 *
 * Each credential has its own key, and one callback URL receives deliveries
 * signed by any of them — a money-out notification arrives from the merchant
 * Default credential even when the transfer used a Specific one. Listing only
 * one means the other credential's deliveries fail verification silently.
 *
 * Each variable also accepts a comma-separated list.
 */
const webhookSecrets = [
  env('SINGAPAY_HMAC_KEY'),
  env('SINGAPAY_MERCHANT_HMAC_KEY', 'SINGAPAY_DEFAULT_HMAC_KEY'),
]
  .flatMap((value) => value.split(','))
  .map((secret) => secret.trim())
  .filter((secret) => secret !== '');

/**
 * Whether money-out calls may run.
 *
 * Separate from {@link hasCredentials} on purpose: a sandbox disbursement is
 * still a real transfer against a real balance, so it stays off unless asked
 * for explicitly.
 */
export const moneyOutEnabled = process.env.SINGAPAY_MONEY_OUT === 'true';

/** The sub-account ULID these tests operate on, when one is configured. */
export const accountId = process.env.SINGAPAY_ACCOUNT_ID ?? null;

/**
 * A client pointed at the sandbox.
 *
 * Never defaults to production: `SINGAPAY_ENV` has to say `production`
 * explicitly, and nothing in this suite should ever say it.
 */
export function e2eClient(options: { moneyOut?: boolean } = {}): SingaPay {
  return new SingaPay({
    environment: process.env.SINGAPAY_ENV === 'production' ? 'production' : 'sandbox',
    clientId: process.env.SINGAPAY_CLIENT_ID ?? '',
    clientSecret: process.env.SINGAPAY_CLIENT_SECRET ?? '',
    apiKey: env('SINGAPAY_API_KEY', 'SINGAPAY_PARTNER_ID'),
    ...(accountId === null ? {} : { accountId }),
    ...(merchantCredentials === null
      ? {}
      : { connections: { [MERCHANT_CONNECTION]: merchantCredentials } }),
    moneyOut: { enabled: options.moneyOut ?? false },
    timeoutMs: 45_000,
    ...(webhookSecrets.length === 0 ? {} : { webhooks: { secrets: webhookSecrets } }),
  });
}

const cache = new Map<string, SingaPay>();

/**
 * A client, built on first use and reused after that.
 *
 * Lazy on purpose. Vitest evaluates a `describe` body even when `skipIf` skips
 * it, so building a client at module scope would throw `ConfigurationError` on
 * every credential-less run — turning a clean skip into a red suite, which is
 * the one outcome this harness must never produce.
 */
export function sharedClient(options: { moneyOut?: boolean } = {}): SingaPay {
  const key = options.moneyOut === true ? 'money-out' : 'read-only';
  const existing = cache.get(key);

  if (existing !== undefined) {
    return existing;
  }

  const built = e2eClient(options);

  cache.set(key, built);

  return built;
}

/**
 * The connection the gateway will actually let perform `probe`.
 *
 * `SP403` — "this account requires its own credential" — means the account is
 * assigned to a Specific credential and only that one may act on it. Which
 * `.env` slot holds it is not knowable from here, so this asks rather than
 * assumes.
 *
 * The permission is **per operation, not per account**: reading a balance and
 * disbursing from the same account are gated separately, so a connection that
 * passes one probe may still be refused another. Each suite probes with the
 * cheapest read-only call for the work it is about to do.
 */
export async function connectionThatCan(
  probe: (client: SingaPay) => Promise<unknown>,
  options: { moneyOut?: boolean } = {},
): Promise<SingaPay> {
  const root = sharedClient(options);
  const candidates = [
    root,
    ...root.connectionNames
      .filter((name) => name !== root.config.connectionName)
      .map((name) => root.connection(name)),
  ];

  for (const candidate of candidates) {
    try {
      await probe(candidate);

      return candidate;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    'No configured credential is allowed to do this with SINGAPAY_ACCOUNT_ID. The ' +
      'dashboard lists which accounts a credential serves under Credential Details > ' +
      'Assigned Accounts; add that credential to .env.',
  );
}

/**
 * One field of a single-record response.
 *
 * Responses are intentionally untyped — the gateway's shapes are per-endpoint
 * and this SDK does not model them — so every read goes through one cast here
 * rather than six copies of it across the suite.
 */
export function field(response: SingaPayResponse, name: string): unknown {
  return (response.data as Record<string, unknown>)[name];
}

/**
 * The first row of a listing, or `null` when the sandbox holds none yet.
 *
 * Reads {@link SingaPayResponse.items}, not `data`: a list endpoint puts its
 * rows there, and `data` is an empty object for them.
 */
export function firstRow(response: SingaPayResponse): Record<string, unknown> | null {
  const row = (response.items ?? [])[0];

  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null;
}

/**
 * A reference number unique to this run.
 *
 * The gateway rejects a reused reference with `SP004`, so a fixed string would
 * pass once and fail forever after — which reads exactly like a broken
 * endpoint rather than like a stale fixture.
 */
export function reference(prefix: string): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const noise = Math.floor(Math.random() * 1296)
    .toString(36)
    .toUpperCase()
    .padStart(2, '0');

  return `${prefix}-${stamp}${noise}`;
}

// Say why the suite is skipping, rather than letting it read as a pass. This
// runs at import so it still prints even though every `describe` is skipped:
// a skipped E2E run that looks identical to a green one is how an integration
// quietly stops being verified.
if (!hasCredentials) {
  // Written straight to stderr rather than through `console`: Vitest
  // intercepts console output and drops what a fully skipped file emits, so a
  // console.warn here would never reach anyone.
  process.stderr.write(
    [
      '',
      `  E2E skipped — missing ${missingCredentials.join(', ')}.`,
      '  Copy .env.example to .env and fill it in to run against the sandbox.',
      '',
      '',
    ].join('\n'),
  );
}
