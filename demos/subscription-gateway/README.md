# subscription-gateway

A subscription-gated API using [MPP](https://mpp.dev) recurring payments on Tempo, with optional Stripe settlement per period.

## How it works

Clients pay once per billing period to access `GET /api/pro`. The server issues an on-chain TIP-20 transfer on activation and on each renewal. Subsequent requests within the same period are served free from the active subscription state — no additional payment.

```
client                        server                              chain
  |                              |                                  |
  |-- GET /api/pro ------------->|                                  |
  |<-- 402 challenge ------------|                                  |
  |-- GET /api/pro + credential->|                                  |
  |                              |-- transferWithMemo() ----------->|
  |                              |<-- txHash -----------------------|
  |                              |   hooks.activated fires          |
  |                              |-- Stripe PaymentIntent --------->|
  |<-- 200 pro content ----------|                                  |
  |                              |                                  |
  |-- GET /api/pro (same period) |                                  |
  |<-- 200 (free reuse) ---------|                                  |
  |                              |                                  |
  |-- GET /api/pro (next period) |                                  |
  |                              |-- transferWithMemo() ----------->|
  |                              |<-- txHash -----------------------|
  |                              |   hooks.renewed fires            |
  |                              |-- Stripe PaymentIntent --------->|
  |<-- 200 pro content ----------|                                  |
```

**Key difference from the session demo:** the server submits the on-chain payment itself (using a stored access key authorized by the client at activation), not the client. There is no client-initiated settle step. This means every billing event — activation and renewal — always produces a tx hash and always fires a hook.

## Stack

- **[mppx](https://mpp.dev)** — payment middleware (`tempo.subscription()` for recurring billing)
- **Tempo** — payment channel network (PathUSD testnet)
- **Stripe** — optional fiat settlement record per period

## Run

```bash
cp .env.example .env  # fill in values
npm install
npm run server        # gateway on :3000
npm run client        # test client (first run activates, subsequent runs reuse)
```

## Stripe settlement (optional)

Set `STRIPE_CONNECTED=true` and `STRIPE_SECRET_KEY` to enable.

### Strategy: one PaymentIntent per billing period

Both `hooks.activated` (period 0) and `hooks.renewed` (periods 1+) create a Stripe PaymentIntent using the on-chain transfer tx hash as proof:

```
mode: "transaction_verification"
transaction_verification_options: { transaction_hash: <transfer-tx>, network: "tempo" }
amount: <plan amount in cents>
metadata: { subscription_id, period_index, payer }
```

Unlike the session demo, there is no `settle()` gap here. The server submits the on-chain payment and receives the tx hash before the hook fires, so PI creation is always triggered. The `idempotencyKey` is the tx hash, so retries are safe.

## Limitations and open questions

**`resolve` is a demo stub.** The `resolve` function maps requests to subscription keys using the `x-user-id` header. In production this needs real authentication (JWT, session cookie, API key) — a bare header is trivially spoofable and would let any caller reuse another user's subscription.

**No background renewal.** Renewals here are lazy: they fire on the next request after a period boundary. If a subscriber never makes another request in a new period, no renewal billing happens. For guaranteed per-period billing, mppx exposes `tempo.renewSubscription()` for use in a cron job. That path would also need to call `stripe.paymentIntents.create()` directly after renewing, since it runs outside the hook lifecycle — same manual wiring as the `settle()` gap in the session demo.

**Stripe subscription object model not mapped.** The current approach records one PI per period but has no Stripe `Customer`, `Subscription`, or `Invoice` object. A fuller integration would:
- Create a Stripe `Customer` on `activated` (keyed by `subscription.payer.address`)
- Create a Stripe `Subscription` with `collection_method: "send_invoice"` and attach the period 0 PI as proof of the first invoice
- Create and finalize a Stripe `Invoice` on each `renewed` event

What Tempo would need to expose for a cleaner mapping: a stable `subscriptionId` is already present on every receipt, but a richer per-period invoice record (period start/end timestamps, cumulative billing history) would make reconciliation against Stripe invoices straightforward.
