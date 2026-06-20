# MPP Sessions — Full PaymentIntent Lifecycle

An AI gateway that charges per token using [MPP](https://mpp.dev) session payments on Tempo, implementing the full Stripe PaymentIntent lifecycle: **authorize at session open, capture at session close**.

## How it works

When a client opens a payment channel, they deposit (escrow) PathUSD on-chain. The server immediately creates a Stripe PaymentIntent authorized for that full deposit amount (`capture_method: "manual"`). As tokens stream, the channel accumulates charges off-chain via signed vouchers. When the client closes and funds settle on-chain, the server updates the PI to the actual settled amount, attaches the settle tx hash as on-chain proof, and confirms (captures).

```
client                        server                          Stripe / chain
  |                              |                                 |
  |-- open channel (deposit) --->|                                 |
  |                              |-- PI.create(deposit, manual) -->| ← authorized for full deposit
  |-- POST /v1/chat/completions->|-- forward to OpenAI ----------->|
  |                              |<-- streaming chunks ------------|
  |<-- SSE: charge + token ------|                                 |
  |<-- SSE: charge + token ------|                                 |
  |       ...                    |                                 |
  |-- close (HTTP: final voucher)|                                 |
  |                              |-- closeOnChain() --> (chain)    |
  |                              |<-- txHash -----------------     |
  |                              |-- PI.update(settled, txHash) -->|
  |                              |-- PI.confirm() --------------->| ← captured for actual spend
```

## Contrast with `just-paymentintent-on-session-close`

| Demo | PI created | Amount authorized | Stripe sees session |
|---|---|---|---|
| `just-paymentintent-on-session-close` | On close only | Settled amount | Only after close |
| `full-lifecycle` (this demo) | On open | Full deposit (escrowed) | From the moment it opens |

The full lifecycle approach is useful when:
- You want Stripe to reflect every opened session, not just settled ones
- You need to detect sessions that opened but never properly closed (PI stays `requires_capture` indefinitely as a signal)
- Your business logic resembles hotel pre-auth: hold the deposit, charge the actual spend

## Stack

- **[mppx](https://mpp.dev)** — payment middleware (`mppx.session()` for per-token SSE charging)
- **Tempo** — payment channel network (PathUSD testnet)
- **OpenAI** — upstream LLM
- **Stripe** — authorize-on-open / capture-on-close PaymentIntent lifecycle

## Run

```bash
cp .env.example .env  # fill in values
npm run server        # gateway on :3000
npm run client        # test client
```

## PaymentIntent lifecycle

**On `action: "open"`:**
```
stripe.paymentIntents.create({
  amount: depositInCents,   // full escrowed deposit
  currency: "usd",
  capture_method: "manual", // authorized, not yet captured
  metadata: { channelId },
})
```

**On `action: "close"`:**
```
stripe.paymentIntents.update(piId, {
  amount: settledInCents,   // actual tokens × price
  transaction_verification_options: { transaction_hash: txHash, network: "tempo" },
})
stripe.paymentIntents.confirm(piId)
```

## Limitations

- **In-memory map.** The `channelId → piId` map is lost on server restart. In production, persist it in a database. If a close arrives after a restart and no open PI is found, the server falls back to creating a new PI directly from the close event.
- **`settle()` bypass.** If the server calls `settle()` directly on an abandoned session, `onPaymentSuccess` does not fire. The open PI stays in `requires_capture` indefinitely — you would need a separate sweep to cancel those.
