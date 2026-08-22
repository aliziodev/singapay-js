/**
 * The thirteen SingaPay webhook types.
 *
 * Several types share one callback URL (`transaction_notif_url` for money-in,
 * `disbursement_notif_url` for money-out), so deliveries are discriminated by
 * payload — primarily the top-level `event` field — never by URL.
 */
export const WebhookType = {
  VirtualAccount: 'va-transaction',
  QrisAcquirer: 'qris-acquirer-transaction',
  PaymentLink: 'payment-link-transaction',
  EwalletMoneyIn: 'ewallet-native-transaction',
  SubscriptionCycle: 'subscription-cycle',
  Disbursement: 'disbursement',
  EwalletTopup: 'ewallet-topup',
  QrisIssuer: 'qris-issuer',
  Settlement: 'settlement',
  DirectDebit: 'direct-debit',
  PaymentLinkInquiry: 'payment-link-inquiry',
  ProductExpiration: 'product-expiration',
  TransactionExpiration: 'transaction-expiration',
} as const;

export type WebhookTypeValue = (typeof WebhookType)[keyof typeof WebhookType];

const KNOWN_TYPES = new Set<string>(Object.values(WebhookType));

function get(payload: unknown, path: readonly string[]): unknown {
  let current: unknown = payload;

  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function fromEventName(event: string): WebhookTypeValue | null {
  if (KNOWN_TYPES.has(event)) {
    return event as WebhookTypeValue;
  }

  // The docs spell the two expiration events with underscores while the
  // gateway sends hyphens. Normalize rather than bet on one spelling.
  const hyphenated = event.replaceAll('_', '-');

  if (hyphenated !== event && KNOWN_TYPES.has(hyphenated)) {
    return hyphenated as WebhookTypeValue;
  }

  if (event.startsWith('subscription.')) {
    return WebhookType.SubscriptionCycle;
  }

  if (event.startsWith('settlement.')) {
    return WebhookType.Settlement;
  }

  if (event.startsWith('payment_link.inquiry')) {
    return WebhookType.PaymentLinkInquiry;
  }

  if (event.startsWith('direct-debit') || event.startsWith('direct_debit')) {
    return WebhookType.DirectDebit;
  }

  return null;
}

/**
 * Identify the webhook type from a decoded payload.
 *
 * Returns `null` for a payload matching no known type. Callers should still
 * process those — a type SingaPay adds later should not be silently dropped.
 */
export function webhookTypeFromPayload(payload: unknown): WebhookTypeValue | null {
  const event = get(payload, ['event']);

  if (typeof event === 'string' && event !== '') {
    const matched = fromEventName(event);

    if (matched !== null) {
      return matched;
    }
  }

  // Payment-link deliveries may omit `event` entirely; fall back to the
  // documented payload-shape discriminators.
  if (
    get(payload, ['data', 'transaction', 'type']) === 'pl' ||
    get(payload, ['data', 'payment', 'method']) === 'payment_link'
  ) {
    return WebhookType.PaymentLink;
  }

  return null;
}
