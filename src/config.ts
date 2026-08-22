import type { TokenStore } from './auth/token-store.js';
import { createMemoryTokenStore } from './auth/token-store.js';
import { JakartaClock } from './clock.js';
import { ConfigurationError } from './errors.js';

export type Environment = 'sandbox' | 'production';

/**
 * The SingaPay services, each on its own host with its own authentication.
 *
 * All three are named here even though v1 of this package only implements
 * `payment`. Keeping the type and the base-URL table complete from the start
 * means adding biller or identity later is additive rather than a change to
 * the shape of the configuration.
 */
export type ServiceHost = 'payment' | 'biller' | 'identity';

/** Access-token scheme: `1.1` is HMAC-signed, `1.0` is HTTP Basic. */
export type AuthVersion = '1.0' | '1.1';

export const DEFAULT_BASE_URLS: Readonly<
  Record<ServiceHost, Readonly<Record<Environment, string>>>
> = {
  payment: {
    sandbox: 'https://sandbox-payment-b2b.singapay.id',
    production: 'https://payment-b2b.singapay.id',
  },
  biller: {
    sandbox: 'https://sandbox-biller-b2b.singapay.id',
    production: 'https://biller-b2b.singapay.id',
  },
  identity: {
    sandbox: 'https://sandbox-apigw.singapay.id',
    production: 'https://api.singapay.id',
  },
};

/** Minimal logger shape, so any logging library can be plugged in. */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type FetchLike = typeof globalThis.fetch;

/** The connection used when none is named. */
export const DEFAULT_CONNECTION = 'default';

/**
 * One dashboard credential set.
 *
 * A merchant can hold several: a merchant-wide **Default** credential, plus
 * **Specific** ones bound to particular sub-accounts. `SP403` refuses the
 * Default credential for an account that has its own, so an application
 * serving several accounts genuinely needs several credential sets rather
 * than one.
 *
 * Only credential-shaped state lives here. The environment, base URLs, the
 * money-out guard, timeouts, retries, webhook tolerance and logging are
 * application policy and stay shared across every connection.
 */
export interface ConnectionOptions {
  clientId: string;
  /**
   * The signing key. Never sent — every signature is derived from it.
   *
   * Swapping this with {@link apiKey} is the most common setup mistake, and
   * it fails as an unexplained authentication error rather than as anything
   * that names the cause.
   */
  clientSecret: string;
  /**
   * The dashboard calls this the **API Key**; the gateway receives it as the
   * `X-PARTNER-ID` header.
   *
   * Named after the dashboard rather than the header because the dashboard is
   * where you copy it from, and a name that matches what is on screen is one
   * fewer chance to paste the client secret here instead.
   */
  apiKey: string;
  /** Default account ULID, used by endpoints that take one. */
  accountId?: string;
  /** Defaults to `1.1`. */
  authVersion?: AuthVersion;
}

export interface SingaPayOptions extends ConnectionOptions {
  /** Defaults to `sandbox`, so an unconfigured environment never touches production. */
  environment?: Environment;
  /**
   * Extra credential sets, each reached with `singapay.connection(name)`.
   *
   * The top-level credentials are themselves the connection named
   * `default`, so adding a second set never disturbs the first.
   */
  connections?: Record<string, ConnectionOptions>;
  /**
   * Override individual base URLs, e.g. to route through a static-IP proxy.
   *
   * Whatever is set here receives the access token and every request
   * signature, so it has to be somewhere you trust as much as the gateway.
   * The scheme is not validated: an `http://` origin sends both in cleartext,
   * which is only ever acceptable inside a private network you control.
   */
  baseUrls?: Partial<Record<ServiceHost, Partial<Record<Environment, string>>>>;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /** Automatic retry, applied to GET requests only. */
  retry?: { times?: number; delayMs?: number };
  /**
   * Guard for every call that moves funds out. Disabled by default: an
   * environment that has not opted in cannot transfer real money.
   */
  moneyOut?: { enabled?: boolean };
  webhooks?: {
    /** Maximum accepted clock skew in seconds. Defaults to 300. */
    toleranceSeconds?: number;
    /**
     * Extra keys accepted when verifying inbound signatures, such as the
     * dashboard HMAC Validation Key. The client secret is always tried.
     */
    secrets?: string[];
  };
  tokenStore?: TokenStore;
  /** Injected in tests, or to add proxy support. Defaults to global `fetch`. */
  fetch?: FetchLike;
  logger?: Logger;
  clock?: JakartaClock;
}

export interface ResolvedConfig {
  environment: Environment;
  /** Which credential set this config resolved, for logs and error messages. */
  connectionName: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
  accountId: string | null;
  authVersion: AuthVersion;
  baseUrls: Record<ServiceHost, string>;
  timeoutMs: number;
  retryTimes: number;
  retryDelayMs: number;
  moneyOutEnabled: boolean;
  webhookToleranceSeconds: number;
  /**
   * Every key that may have signed an inbound delivery: the client secret of
   * *every* configured connection, plus the shared extras from
   * `webhooks.secrets`. Identical across connections, because one callback
   * URL receives deliveries signed by any of them.
   */
  webhookSecrets: string[];
  tokenStore: TokenStore;
  fetch: FetchLike;
  logger: Logger;
  clock: JakartaClock;
}

const noopLogger: Logger = {
  debug() {},
  warn() {},
  error() {},
};

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(`Missing required SingaPay configuration: ${field}.`);
  }

  return value;
}

function resolveBaseUrls(
  environment: Environment,
  overrides: SingaPayOptions['baseUrls'],
): Record<ServiceHost, string> {
  const hosts = Object.keys(DEFAULT_BASE_URLS) as ServiceHost[];
  const resolved = {} as Record<ServiceHost, string>;

  for (const host of hosts) {
    const override = overrides?.[host]?.[environment];
    // Trailing slashes would double up against paths that already start with
    // one, and the path is part of the signed ENDPOINT string.
    resolved[host] = (override ?? DEFAULT_BASE_URLS[host][environment]).replace(/\/+$/, '');
  }

  return resolved;
}

/**
 * Every configured connection name, the default one first.
 */
export function connectionNames(options: SingaPayOptions): string[] {
  const declared = Object.keys(options.connections ?? {}).filter(
    (name) => name !== DEFAULT_CONNECTION,
  );

  return [DEFAULT_CONNECTION, ...declared];
}

/**
 * The credential set behind a connection name.
 *
 * The top-level options *are* the `default` connection, unless the
 * connections map declares one explicitly, so a single-credential
 * configuration needs to know nothing about any of this.
 *
 * @throws {ConfigurationError} When no such connection is configured.
 */
function credentialsFor(options: SingaPayOptions, name: string): ConnectionOptions {
  const declared = options.connections?.[name];

  if (declared !== undefined) {
    return declared;
  }

  if (name === DEFAULT_CONNECTION) {
    return options;
  }

  throw new ConfigurationError(
    `Unknown SingaPay connection "${name}". Configured: ${connectionNames(options).join(', ')}.`,
  );
}

/**
 * Collect every key that could have signed an inbound webhook.
 *
 * One callback URL receives deliveries signed by more than one credential.
 * Verified against the sandbox: a disbursement made with a Specific credential
 * was notified by the merchant Default credential, and signed with *that*
 * credential's secret. Verifying against only the calling
 * connection rejects such deliveries — silently, in production, on money-out.
 * So every connection contributes its secret.
 *
 * A connection missing its secret is skipped rather than allowed to break
 * verification for the ones that have it.
 */
function collectWebhookSecrets(options: SingaPayOptions): string[] {
  const secrets: string[] = [];

  for (const name of connectionNames(options)) {
    const secret = credentialsFor(options, name).clientSecret;

    if (typeof secret === 'string' && secret.trim() !== '') {
      secrets.push(secret);
    }
  }

  secrets.push(...(options.webhooks?.secrets ?? []));

  return [...new Set(secrets)];
}

/**
 * Validate and fill in the options, once, at construction time.
 *
 * @param connection Which credential set to bind. Defaults to `default`.
 *
 * @throws {ConfigurationError} When the connection is unknown, a credential is missing, or a value is not recognized.
 */
export function resolveConfig(
  options: SingaPayOptions,
  connection: string = DEFAULT_CONNECTION,
): ResolvedConfig {
  const credentials = credentialsFor(options, connection);
  const field = (name: string): string =>
    connection === DEFAULT_CONNECTION ? name : `connections.${connection}.${name}`;

  const environment = options.environment ?? 'sandbox';

  if (environment !== 'sandbox' && environment !== 'production') {
    throw new ConfigurationError(
      `Invalid environment "${String(environment)}": expected "sandbox" or "production".`,
    );
  }

  const authVersion = credentials.authVersion ?? '1.1';

  if (authVersion !== '1.0' && authVersion !== '1.1') {
    throw new ConfigurationError(
      `Invalid ${field('authVersion')} "${String(authVersion)}": expected "1.0" or "1.1".`,
    );
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new ConfigurationError(
      'No fetch implementation available. Use Node 20+, or pass options.fetch.',
    );
  }

  return {
    environment,
    connectionName: connection,
    clientId: requireNonEmpty(credentials.clientId, field('clientId')),
    clientSecret: requireNonEmpty(credentials.clientSecret, field('clientSecret')),
    apiKey: requireNonEmpty(credentials.apiKey, field('apiKey')),
    accountId: credentials.accountId ?? null,
    authVersion,
    baseUrls: resolveBaseUrls(environment, options.baseUrls),
    timeoutMs: options.timeoutMs ?? 30_000,
    retryTimes: options.retry?.times ?? 2,
    retryDelayMs: options.retry?.delayMs ?? 200,
    moneyOutEnabled: options.moneyOut?.enabled ?? false,
    webhookToleranceSeconds: options.webhooks?.toleranceSeconds ?? 300,
    webhookSecrets: collectWebhookSecrets(options),
    tokenStore: options.tokenStore ?? createMemoryTokenStore(),
    fetch: fetchImpl.bind(globalThis),
    logger: options.logger ?? noopLogger,
    clock: options.clock ?? new JakartaClock(),
  };
}

/**
 * The configured default account ULID.
 *
 * @throws {ConfigurationError} When no account id was configured and none was passed.
 */
export function requireAccountId(config: ResolvedConfig, accountId?: string): string {
  const resolved = accountId ?? config.accountId;

  if (resolved === null || resolved === undefined || resolved === '') {
    throw new ConfigurationError(
      'No account id available. Pass one to the call, or set accountId when constructing the client.',
    );
  }

  return resolved;
}

/**
 * Every dashboard HMAC Validation Key named in the environment.
 *
 * A merchant holding several credentials has several of these — one per
 * credential — and a single callback URL receives deliveries signed by any of
 * them. So this is a list, comma-separated, not a single value. A hex key
 * never contains a comma, so splitting on one is unambiguous.
 */
function webhookSecretsFromEnv(env: Record<string, string | undefined>): string[] {
  return (env.SINGAPAY_HMAC_KEY ?? '')
    .split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret !== '');
}

/**
 * Build options from `SINGAPAY_*` environment variables.
 *
 * Anything passed in `overrides` wins, so a value can always be supplied in
 * code without unsetting the variable.
 */
export function optionsFromEnv(overrides: Partial<SingaPayOptions> = {}): SingaPayOptions {
  const env = globalThis.process?.env ?? {};
  const environment = env.SINGAPAY_ENV;

  return {
    environment: (environment === 'production' ? 'production' : 'sandbox') as Environment,
    clientId: env.SINGAPAY_CLIENT_ID ?? '',
    clientSecret: env.SINGAPAY_CLIENT_SECRET ?? '',
    // SINGAPAY_PARTNER_ID is still honoured: it is what the header is called,
    // and what existing setups already have in their environment.
    apiKey: env.SINGAPAY_API_KEY ?? env.SINGAPAY_PARTNER_ID ?? '',
    ...(env.SINGAPAY_ACCOUNT_ID === undefined ? {} : { accountId: env.SINGAPAY_ACCOUNT_ID }),
    moneyOut: { enabled: env.SINGAPAY_MONEY_OUT === 'true' },
    ...(webhookSecretsFromEnv(env).length === 0
      ? {}
      : { webhooks: { secrets: webhookSecretsFromEnv(env) } }),
    ...overrides,
  };
}
