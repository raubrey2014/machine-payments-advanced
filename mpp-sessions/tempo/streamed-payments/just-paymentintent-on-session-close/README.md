# mpp-sessions-demos

An AI gateway that charges per token using [MPP](https://mpp.dev) session payments on Tempo, with optional Stripe settlement.

## How it works

Clients open a payment channel (depositing PathUSD into escrow), then stream chat completions from `POST /v1/chat/completions`. The server charges **$0.0001 per token** by calling `stream.charge()` before yielding each OpenAI chunk. When the client closes the session, funds settle on-chain and — if Stripe is connected — a PaymentIntent is created using the settle transaction hash as proof of payment.

```
client                        server                       upstream
  |                              |                              |
  |-- open channel (on-chain) -->|                              |
  |-- POST /v1/chat/completions->|-- forward to OpenAI ------->|
  |                              |<-- streaming chunks ---------|
  |<-- SSE: charge + token ------|                              |
  |<-- SSE: charge + token ------|                              |
  |       ...                    |                              |
  |-- close (HTTP: final voucher)|                              |
  |                              |-- closeOnChain() ----------->| (chain)
  |                              |<-- txHash -------------------|
  |                              |-- Stripe PaymentIntent ----->|
```

## Stack

- **[mppx](https://mpp.dev)** — payment middleware (`mppx.session()` for per-token SSE charging)
- **Tempo** — payment channel network (PathUSD testnet)
- **OpenAI** — upstream LLM
- **Stripe** — optional fiat settlement record on close

## Run

```bash
cp .env.example .env  # fill in values
npm run server        # gateway on :3000
npm run client        # test client
```

## Stripe settlement (optional)

Set `STRIPE_CONNECTED=true` and `STRIPE_SECRET_KEY` to enable.

### Strategy: single PaymentIntent on channel close

The server listens for `onPaymentSuccess` events and filters to `action === "close"` only. When the client closes the channel, funds settle on-chain in a single transaction. The server creates one PaymentIntent using that settle tx hash as proof:

```
mode: "transaction_verification"
transaction_verification_options: { transaction_hash: <settle-tx>, network: "tempo" }
amount: <cumulative tokens × price>
```

This works because individual `stream.charge()` calls are purely off-chain signed vouchers — no tx hash exists until the channel actually settles. The settle tx is the only verifiable on-chain anchor, so one PI per close is the natural fit.

**Limitation — `settle()` bypasses `onPaymentSuccess`:** `close()` on the client is an HTTP request carrying a final signed voucher; the server receives it, calls `closeOnChain()`, gets the `txHash`, and then fires `onPaymentSuccess("close")`. This path is reliable as long as the HTTP request arrives. But if the server ever calls `settle()` directly — whether for mid-session partial settlements or to recover an abandoned session — that is a plain utility function with no hook. `onPaymentSuccess` never fires, and no PI is created.

This means two scenarios produce on-chain settlements with no corresponding Stripe record:

1. **In-flight close failure.** The client calls `close()` but the HTTP request never reaches the server (crash or network drop mid-call). The server holds the highest accumulated voucher and can call `settle()` itself, but doing so silently skips PI creation.

2. **Abandoned sessions.** The client disappears without calling `close()`. The server is responsible for settling those funds — it must call `settle()` proactively — but again has no hook to create the PI afterward. A server-side idle session manager is required, and it would need to call `stripe.paymentIntents.create()` manually after each `settle()` call rather than relying on `onPaymentSuccess`.

## Limitations and future strategies

Two alternative strategies become viable depending on what Tempo exposes:

**Per-checkpoint PI (Strategy B)**
If Tempo emits a distinct `action: "settle"` (or `"checkpoint"`) event alongside `action: "close"`, each on-chain settlement — whether a mid-session partial settle or the final close — would carry its own `txHash` and incremental amount. The server could create one PI per event, giving a full audit trail across manual settles. Tempo would need to surface the per-settle tx hash and the delta amount (not just the cumulative) on each event.

**PI at open, confirmed on close (Strategy C)**
Create a PI with `amount: 0` when the channel opens, then update and confirm it with the real amount and tx hash on close. This gives Stripe a record of the full session lifecycle — including sessions that are opened but never closed — at the cost of leaving a pending PI open mid-session. Tempo would need to expose a stable channel ID at open time to use as the PI's idempotency key across the two calls.
