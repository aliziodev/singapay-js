# AGENTS.md

Instructions for an AI agent working **on this repository**. If you are writing
code that *uses* the published package, read [`llms.txt`](llms.txt) instead.

## What this is

An unofficial TypeScript SDK for the SingaPay payment gateway. Single package,
framework-agnostic, server-only, **zero runtime dependencies** — keep it that
way. A new runtime dependency needs the maintainer's explicit approval; it is a
selling point, not an accident.

## Commands

```bash
pnpm install
pnpm test         # 178 hermetic unit tests, no network, no credentials
pnpm typecheck    # tsc -b
pnpm lint         # biome (use `pnpm lint:fix` to apply)
pnpm build        # tsdown
pnpm test:e2e     # live sandbox — read the warning below first
```

All four of the first commands must pass before you finalise anything.

## Toolchain traps that will waste your time

**Two different Node floors, and they are not the same number.** The package
*runs* on Node 20+, but tsdown *builds* only on Node 22+ — it uses
`Promise.withResolvers`. CI runs lint/typecheck/test across 20/22/24, then
builds once on 22 and loads the built artefacts under Node 20 to prove the
`engines` claim. Do not put `pnpm build` back into the test matrix.

**`tsdown.config.mjs` must stay `.mjs`, and `pnpm build` must keep
`--config-loader native`.** tsdown picks its config loader from what the
*runtime* can do, not from the file extension:
`isBun || nativeTS && isSupported ? "native" : "unrun"`. On Node 20 it reaches
for `unrun`, which tsdown declares only as a peer dependency and does not
install, and the build dies with `Failed to import module "unrun"`. Renaming
the config alone does not fix it; forcing the loader does.

**Writing files through Bash heredocs mangles `\n` and apostrophes.** Use the
Write or Edit tool for `.ts` and `.md`, or a Python heredoc that does not need
escaping.

## Things you must not do

**Never hand-edit `test/fixtures/signature-vectors.json`.** It is the oracle
that pins JSON canonicalization: 18 vectors, each storing the payload, the
canonical bytes, the SHA-256 hash and the expected HMAC signature. If a vector
fails, **the normalizer is wrong** — relaxing the fixture turns a signature the
gateway will reject into a test suite that says everything is fine. New vectors
are welcome but must be derived from gateway behaviour, never from this
normalizer's own output.

**Never remove the money-out guard or make it opt-out.** Every call that moves
funds throws `MoneyOutDisabledError` until `moneyOut: { enabled: true }`. The
guard keys on `ApiRequest.moneyOut`, **not** on `signed` — direct-debit charge
is signed but collects money, so it is deliberately unguarded.

**Never make the SDK retry a write.** Retries are for idempotent reads only.
`SP001`/`SP005` surface as `IndeterminateOutcomeError` because the outcome is
*unknown*, not failed: a blind retry can duplicate a real transfer.

## Running the live E2E suite

`pnpm test:e2e` talks to the real SingaPay sandbox. It skips itself cleanly
without credentials, so it is safe to run blind — but once `.env` is filled in,
understand what it costs:

- **`SINGAPAY_MONEY_OUT=true` moves a real sandbox balance.** One transfer per
  run, minimum 10,000, plus a fee charged on top.
- **The card product has a daily transaction quota.** The suite takes one
  payment per run and shares it; taking one per test exhausted the quota in a
  few runs and turned the suite red for reasons unrelated to the code.
- **A sub-account cannot be deleted once any transaction touches it** —
  `400 Account has existing transactions`, from nothing more than one unpaid
  payment link. Do not create sub-accounts casually; five are already stuck in
  the sandbox from exactly this mistake.
- Never point `SINGAPAY_ENV` at `production`.

## The lesson that cost the most

**A test that only asserts `successful: true` cannot tell a working call from
a silently-ignored field.** The gateway drops unknown fields without
complaining. Sending `type` instead of `account_type` created accounts with no
type at all — every response looked healthy, `partner` was "accepted" because
nothing validated it, and a full round of conclusions was drawn from it before
a human noticed an empty column in the dashboard.

So assert that what you sent **came back**, not merely that the call succeeded.

## Conventions

- Match the surrounding comment density and idiom. Comments here explain *why*,
  and especially why something that looks wrong is deliberate.
- Commit messages are Conventional Commits, and **must never carry a
  `Co-Authored-By` trailer**.
- Releases are automated: bump `version` in `package.json`, push to `main`, and
  `.github/workflows/release.yml` publishes through OIDC Trusted Publishing and
  tags the commit. There is no `NPM_TOKEN`, and adding one back would hand npm
  an empty credential instead of using OIDC. A push that does not bump the
  version is a no-op.
