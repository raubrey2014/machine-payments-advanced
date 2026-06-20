# MPP Sessions — Pay-as-You-Go, Full Lifecycle

A gated API that charges **$0.01 per request** using MPP session payments on Tempo, with the full Stripe PaymentIntent lifecycle: authorize at session open, capture at session close.

## How it differs from streamed-payments

Both patterns use the same channel mechanics (open → vouchers → close). The difference is in how individual charges are triggered:

| | `streamed-payments` | `pay-as-you-go` |
|---|---|---|
| Transport | SSE (`sse: true`) | Plain HTTP |
| Charge granularity | Per token within a continuous stream | Per discrete request |
| Charge mechanism | Explicit `await stream.charge()` in async generator | Implicit — `mppx.session()` middleware deducts before handler runs |
| Client API | `session.sse()` | `session.fetch()` |
| Use case | LLM token streams, live data feeds | Photo APIs, search queries, any per-call billing |

In the pay-as-you-go model the channel is opened once and then reused across many independent HTTP requests. Each request carries an off-chain signed voucher; no per-request blockchain transaction occurs. The channel settles on-chain only when `session.close()` is called.

## Payment lifecycle

```
client                        server                          Stripe
  |                              |                                 |
  |-- GET /photos/1 (open+pay) ->|                                 |
  |                              |-- PI.create(deposit, manual) -->| ← authorized at open
  |<-- 200 photo ----------------|                                 |
  |-- GET /photos/2 (voucher) -->|                                 |
  |<-- 200 photo ----------------|                                 |
  |-- GET /photos/3 (voucher) -->|                                 |
  |<-- 200 photo ----------------|                                 |
  |-- session.close() ---------->|                                 |
  |                              |-- closeOnChain() --> (chain)    |
  |                              |-- PI.update(settled, txHash) -->|
  |                              |-- PI.confirm() --------------->| ← captured at close
```

## Stack

- **[mppx](https://mpp.dev)** — per-request session middleware (no SSE)
- **Tempo** — payment channel network (PathUSD testnet)
- **Stripe** — authorize-on-open / capture-on-close PaymentIntent lifecycle (stubbed)

## Run

```bash
cp .env.example .env  # fill in values
npm run server        # gateway on :3000
npm run client        # fetches 3 photos, then closes the session
```

## Design notes

### No explicit charge() call

Unlike the streamed-payments pattern, the handler doesn't call `stream.charge()`. The `mppx.session()` middleware verifies and deducts the voucher amount before the handler runs — if payment fails the request gets a 402 before the handler is reached.

### Stripe stub

The `transaction_verification_options` PI shape doesn't exist yet. The Stripe calls are stubbed with console logging. See `../../API-REVIEW.md` for the full design discussion.
