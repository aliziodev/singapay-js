import { AccessTokenProvider } from './auth/access-token-provider.js';
import { AccessTokenSigner } from './auth/access-token-signer.js';
import { RequestSigner } from './auth/request-signer.js';
import type { TokenProvider } from './auth/token-provider.js';
import type { ResolvedConfig, SingaPayOptions } from './config.js';
import { connectionNames, DEFAULT_CONNECTION, resolveConfig } from './config.js';
import { Accounts, Balance, Statements } from './endpoints/accounts.js';
import {
  Card,
  DirectDebit,
  EwalletMoneyIn,
  PaymentLinkHistories,
  PaymentLinks,
  Qris,
  Subscriptions,
  VaTransactions,
  VirtualAccounts,
} from './endpoints/money-in.js';
import {
  AccountTransfer,
  CardlessWithdrawal,
  Disbursement,
  EwalletMoneyOut,
  QrisMoneyOut,
} from './endpoints/money-out.js';
import { BrowserUsageError } from './errors.js';
import type { ApiRequest } from './http/client.js';
import { SingaPayClient } from './http/client.js';
import type { SingaPayResponse } from './http/response.js';
import type { VerifiedWebhook, WebhookHeaderSource } from './webhooks/verify.js';
import { verifyWebhook } from './webhooks/verify.js';

function assertServerRuntime(): void {
  if (typeof globalThis === 'object' && 'window' in globalThis) {
    throw new BrowserUsageError(
      'This SDK is server-only. Every request is signed with your client secret, so bundling it into a browser would expose credentials that can move real money. Call SingaPay from your server and send only public artefacts (payment_url, qr_string, virtual_account_no) to the browser.',
    );
  }
}

/**
 * The SingaPay client.
 *
 * ```ts
 * const singapay = new SingaPay({
 *   environment: 'sandbox',
 *   clientId: process.env.SINGAPAY_CLIENT_ID!,
 *   clientSecret: process.env.SINGAPAY_CLIENT_SECRET!,
 *   apiKey: process.env.SINGAPAY_PARTNER_ID!,
 *   accountId: process.env.SINGAPAY_ACCOUNT_ID!,
 * });
 *
 * const link = await singapay.paymentLinks.create({
 *   reff_no: 'INV-1001',
 *   payment_link_type: 'total',
 *   total_amount: 150_000,
 * });
 * ```
 *
 * Server-only by design, not by limitation — see {@link assertServerRuntime}.
 */
export class SingaPay {
  readonly config: ResolvedConfig;
  readonly client: SingaPayClient;
  readonly tokens: TokenProvider;

  /** Every configured connection name, the default one first. */
  readonly connectionNames: readonly string[];

  private readonly options: SingaPayOptions;
  private readonly siblings = new Map<string, SingaPay>();

  readonly accounts: Accounts;
  readonly balance: Balance;
  readonly statements: Statements;
  readonly virtualAccounts: VirtualAccounts;
  readonly vaTransactions: VaTransactions;
  readonly paymentLinks: PaymentLinks;
  readonly paymentLinkHistories: PaymentLinkHistories;
  readonly qris: Qris;
  readonly ewallet: EwalletMoneyIn;
  readonly card: Card;
  readonly subscriptions: Subscriptions;
  readonly directDebit: DirectDebit;

  readonly disbursement: Disbursement;
  readonly ewalletMoneyOut: EwalletMoneyOut;
  readonly qrisMoneyOut: QrisMoneyOut;
  readonly accountTransfer: AccountTransfer;
  readonly cardlessWithdrawal: CardlessWithdrawal;

  constructor(options: SingaPayOptions, connection: string = DEFAULT_CONNECTION) {
    assertServerRuntime();

    this.options = options;
    this.connectionNames = connectionNames(options);
    this.config = resolveConfig(options, connection);
    this.tokens = new AccessTokenProvider(this.config, new AccessTokenSigner(this.config.clock));
    this.client = new SingaPayClient(this.config, this.tokens, new RequestSigner());

    this.accounts = new Accounts(this.client, this.config);
    this.balance = new Balance(this.client, this.config);
    this.statements = new Statements(this.client, this.config);
    this.virtualAccounts = new VirtualAccounts(this.client, this.config);
    this.vaTransactions = new VaTransactions(this.client, this.config);
    this.paymentLinks = new PaymentLinks(this.client, this.config);
    this.paymentLinkHistories = new PaymentLinkHistories(this.client, this.config);
    this.qris = new Qris(this.client, this.config);
    this.ewallet = new EwalletMoneyIn(this.client, this.config);
    this.card = new Card(this.client, this.config);
    this.subscriptions = new Subscriptions(this.client, this.config);
    this.directDebit = new DirectDebit(this.client, this.config);

    this.disbursement = new Disbursement(this.client, this.config);
    this.ewalletMoneyOut = new EwalletMoneyOut(this.client, this.config);
    this.qrisMoneyOut = new QrisMoneyOut(this.client, this.config);
    this.accountTransfer = new AccountTransfer(this.client, this.config);
    this.cardlessWithdrawal = new CardlessWithdrawal(this.client, this.config);
  }

  /**
   * The SDK bound to another credential set.
   *
   * ```ts
   * await singapay.disbursement.transfer({ ... });                  // default
   * await singapay.connection('payouts').disbursement.transfer({ ... });
   * ```
   *
   * `SP403` refuses the merchant Default credential for a sub-account that
   * holds its own, which is what makes several credential sets necessary
   * rather than convenient.
   *
   * Instances are memoized and cheap; they share the configured token store,
   * and tokens are cached per client id, so a second connection never reuses
   * the first one's token.
   *
   * @throws {ConfigurationError} When no such connection is configured.
   */
  connection(name: string = DEFAULT_CONNECTION): SingaPay {
    if (name === this.config.connectionName) {
      return this;
    }

    let sibling = this.siblings.get(name);

    if (sibling === undefined) {
      sibling = new SingaPay(this.options, name);
      this.siblings.set(name, sibling);
    }

    return sibling;
  }

  /**
   * Verify an inbound webhook.
   *
   * Checked against the client secret of *every* configured connection plus
   * the shared extra keys, because one callback URL receives deliveries
   * signed by more than one credential — see {@link ResolvedConfig.webhookSecrets}.
   * Which connection this instance is bound to makes no difference.
   *
   * @param endpoint The callback path exactly as configured in the dashboard.
   */
  verifyWebhook(
    rawBody: string,
    headers: WebhookHeaderSource,
    endpoint: string,
  ): Promise<VerifiedWebhook> {
    return verifyWebhook({
      rawBody,
      headers,
      endpoint,
      secrets: this.config.webhookSecrets,
      toleranceSeconds: this.config.webhookToleranceSeconds,
      clock: this.config.clock,
    });
  }

  /**
   * Escape hatch for an endpoint this SDK does not wrap yet.
   *
   * Signing, auth, retries and envelope handling still apply.
   *
   * **The money-out guard does not.** It keys on `moneyOut: true` in the
   * request, so a hand-built call to a path that moves funds bypasses it
   * unless you set that flag yourself. Set it on anything that pays out, or
   * the one protection standing between a bug and a real transfer is gone.
   */
  request(request: ApiRequest): Promise<SingaPayResponse> {
    return this.client.send(request);
  }
}
