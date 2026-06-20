# API Review: Supporting MPP Sessions in Stripe

## Goal

MPP sessions allow for micro-payments drawn from an initial lump sum deposited upfront: the client opens a channel by escrowing funds on-chain, then pays incrementally per token (or per unit) via off-chain signed vouchers, and the channel settles — returning any unspent deposit — when it closes. The central design question for Stripe integration is **how much of the session lifecycle to reflect in the PaymentIntent lifecycle**.

The spectrum runs from minimal (one PI only after the session closes) to maximal (PI mirrors every phase: open, stream, close). The right answer depends on what Stripe needs to be useful to the platform — and on what the MPP protocol currently exposes.

---

## Modeling options and tradeoffs

### Option 1 — PI on close only (`just-paymentintent-on-session-close`)

Create one PI when the channel closes and on-chain settlement is confirmed. The PI carries the settle tx hash as proof via `transaction_verification_options`.

**Stripe sees:** one `succeeded` PI per session, after the fact.

**Tradeoffs:**
- Simple. No state to track across session lifecycle. No in-flight PI to clean up if the session never closes.
- Stripe has zero visibility into sessions that are currently open. Can't detect abandoned sessions, can't track session volume in real time.
- There is a gap: if `settle()` is called directly by the server (to recover an abandoned session), `onPaymentSuccess` does not fire and no PI is created. Abandoned sessions produce on-chain settlements with no Stripe record.

### Option 2 — PI at open, confirmed on close (`full-lifecycle`)

Create a PI with `capture_method: "manual"` when the channel opens, authorized for the full escrowed deposit. Update the amount to the actual settled value and confirm it when the channel closes.

**Stripe sees:** one PI per session from the moment it opens, transitioning `requires_capture → succeeded`.

**Tradeoffs:**
- Stripe has a record of every opened session, not just settled ones. Abandoned sessions show up as stuck `requires_capture` PIs — a signal something went wrong.
- The hotel analogy: hold the deposit at check-in, charge the actual spend at checkout. The authorization amount (deposit) and the capture amount (actual usage) are different — this requires Stripe to support updating the amount between auth and capture, which is standard for `capture_method: "manual"` but not universal across payment methods.
- Requires tracking a `channelId → piId` map server-side across the session lifecycle. If the server restarts between open and close, that map is lost (fallback: create a new PI at close instead).
- Requires Tempo to expose a stable `channelId` at open time so the open and close events can be correlated.

---

## Stripe dependencies

None of this works without the `transaction_verification_options` PI shape — the ability to create or confirm a PI by referencing an on-chain tx hash rather than a traditional payment method. That is a new capability.

Specifically required:
- `mode: "transaction_verification"` (or equivalent) on `paymentIntents.create` — lets a server-created PI be confirmed by pointing at an existing on-chain settle tx. This is what makes Option 1 viable.
- The ability to `update` a PI's `amount` and then `confirm` it with `transaction_verification_options` at a later point — what makes Option 2 viable. The PI is created at open without a tx hash, and the hash is only known at close.

Without these, the only available path would be the old `payment_method_types` shape — which is addressed in Alternatives Considered below.

---

## Alternatives considered

### Old PI shape (`payment_method_types: ["tempo_channel"]`)

The old shape relies on Stripe's async on-chain listener: Stripe monitors the blockchain for a transaction that exactly matches the PI amount, then auto-confirms the PI. This is incompatible with MPP sessions for two reasons:

1. **Variable settlement amounts.** Session settlements are the accumulated per-token charges — a value that isn't known until the channel closes. There is no fixed amount to put on the PI at creation time, so Stripe's matcher can never find an exact match.
2. **No confirm call.** In this shape Stripe owns confirmation asynchronously. The server calling `PI.confirm()` at session close is not part of the flow — it either fails (if Stripe already confirmed) or is meaningless (if Stripe never saw the deposit because it went to the server wallet, not the Stripe deposit address).

The natural workaround — embedding the PI ID in the on-chain transaction so Stripe's listener can correlate by ID rather than by amount — requires writing metadata into the settle transaction (e.g., a tx memo or calldata field). We investigated this and backed out: it requires coordination between the mppx settlement layer and Stripe's on-chain indexer to agree on a memo format, adds on-chain data costs, and creates a Stripe-specific encoding concern in otherwise payment-agnostic transaction construction. The `transaction_verification_options` shape sidesteps all of this by inverting the flow — the server presents the tx hash to Stripe rather than Stripe discovering the transaction itself.

A deeper exploration of this path and why it dead-ends is in `tempo/full-lifecycle-old-pi-shape/README.md`.

---

## Open questions

### Minimum charge — what happens when a session uses less than 1¢?

At $0.0001/token, 100 tokens = 1¢. A session that exchanges fewer tokens settles for a sub-cent amount on-chain. Stripe requires a minimum charge of 1¢ (or equivalent) for most currencies.

Options:
- **Round up to 1¢.** Simplest. The PI amount is always at least 1¢ even if the actual usage was less. The on-chain settlement may be sub-cent (PathUSD has 6 decimal places of precision), so the PI amount would diverge slightly from the on-chain amount.
- **No minimum — allow sub-cent PIs.** Requires verifying whether Stripe will accept a `0` or sub-cent amount on a `transaction_verification` PI. Probably not for traditional payment flows, but a tx-verification PI may have different rules since it's a record, not a charge.
- **Session minimum price.** Enforce a minimum deposit (e.g., 1¢) when the channel opens, so any session that starts is guaranteed to settle for at least 1¢. The remaining deposit is returned to the payer on close. This is the cleanest UX but requires the channel open to enforce a floor.

### Top-up: does `incrementAuthorization` work on `transaction_verification` PIs?

Clients can top up an active channel without closing it — depositing additional funds into the on-chain escrow so a long-running session can continue past its original deposit ceiling. The protocol exposes this as a first-class credential action (`action: 'topUp'`), and mppx fires `onPaymentSuccess` with the action discriminator and an `additionalDeposit` field on the credential payload (not on the receipt). The server implementation handles this: on `topUp`, it calls `stripe.paymentIntents.incrementAuthorization(piId, { amount: newTotal })` to extend the existing hold.

The open question is **whether `incrementAuthorization` is supported on `transaction_verification` PIs**. Standard Stripe `incrementAuthorization` works on manual-capture card PIs, but the `transaction_verification` shape is a preview API that links a PI to an on-chain tx hash rather than a card. These may be different code paths in Stripe's backend. Possible outcomes:

1. **It works as-is.** The existing stub code is correct; swap the stub for real Stripe calls.
2. **`transaction_verification` PIs don't support `incrementAuthorization`.** Fallback options:
   - Create a **separate PI per top-up** and track a list of PI IDs per channel. At close, capture the original PI and confirm the top-up PIs each for their deposit amount. More objects, but clean semantics.
   - **Accept the stale auth** — don't update the PI when a top-up happens. The on-chain escrow is the real guarantee; the PI amount will be lower than the actual deposit ceiling. The gap is covered at close by capping `amount_to_capture` to the PI's authorized amount. Simplest but loses Stripe visibility into top-up events.

The state management implication is already handled: `pendingPaymentIntents` now stores `{ piId, authorizedCents }` rather than just `piId`, so the running authorized total is available to compute the new total for `incrementAuthorization` without re-querying Stripe. A server restart between open and a top-up loses `authorizedCents`, which means the increment can't be computed from the baseline — an argument for persisting this map to a database rather than keeping it in-memory.

### Consistency with other payment methods (SPTs, cards)

The session demos currently use "close only" or "open + close" lifecycle modeling. If SPTs (Stream Payment Transactions) or card-on-file flows for similar per-unit billing use a different modeling strategy — e.g., a PI per charge event rather than per session — then sessions would be a first-class inconsistency in the Stripe object model.

The risk: a platform that accepts both MPP sessions and cards for per-token API billing would see fundamentally different PI shapes for the same business event. Sessions produce one PI per channel lifetime; cards might produce one PI per request. Reconciliation, fraud signals, and reporting all become payment-method-specific.

The question to answer before shipping: **should MPP sessions produce the same PI shape as other payment methods for equivalent usage patterns?** If yes, that constrains the modeling choice here significantly. The "close only" option is the least constraining to keep options open; the "open + close" option (Option B) is a richer model that would need equivalents for SPTs and cards before it's generalized.
