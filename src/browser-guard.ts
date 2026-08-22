import { BrowserUsageError } from './errors.js';

/**
 * The module a browser bundler resolves to, via the `browser` export condition.
 *
 * Every SingaPay request is signed with the client secret. The moment that
 * secret reaches a browser bundle, anyone can read it in DevTools and
 * disburse from the merchant balance. That is not a bug to be fixed by moving
 * signing to the client — it would dismantle the whole security model.
 *
 * The correct architecture for a browser app is:
 *
 * ```
 * React/Vue (browser) -> your server -> @aliziodev/singapay -> SingaPay
 * ```
 *
 * Only public artefacts travel to the browser: `payment_url`, `qr_string`,
 * `checkout_url`, `virtual_account_no`. Never credentials, never signatures.
 *
 * Failing loudly at build or first import beats leaking a secret quietly.
 */
throw new BrowserUsageError(
  '@aliziodev/singapay cannot run in a browser: it signs every request with your client secret. Call it from your server and send only public artefacts to the browser.',
);
