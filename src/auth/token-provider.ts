/**
 * How the client obtains a bearer token for a service host.
 *
 * SingaPay uses different token schemes per service: the payment host speaks
 * schemes A and B, and the identity host has its own credential exchange
 * entirely. Only the payment host is implemented in v1, but the seam is an
 * interface from the start so adding another scheme later is a new
 * implementation rather than a change to the client.
 */
export interface TokenProvider {
  /** A valid bearer token, fetching and caching one when needed. */
  token(): Promise<string>;

  /** Discard any cached token, so the next call fetches a fresh one. */
  forget(): Promise<void>;
}
