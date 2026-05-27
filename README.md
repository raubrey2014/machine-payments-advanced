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
  |-- close channel (on-chain) ->|                              |
  |                              |-- Stripe PaymentIntent ----->|
```

## Stack

- **[mppx](https://mpp.dev)** — payment middleware (`mppx.session()` for per-token SSE charging)
- **Tempo** — L2 payment channel network (PathUSD testnet)
- **OpenAI** — upstream LLM
- **Stripe** — optional fiat settlement record on close

## Run

```bash
cp .env.example .env  # fill in values
npm run server        # gateway on :3000
npm run client        # test client
```

## Stripe settlement (optional)

Set `STRIPE_CONNECTED=true` and `STRIPE_SECRET_KEY` to enable. On session close, the server creates a PaymentIntent with the settle `transaction_hash` and `network: "tempo"` — a hypothetical Stripe API shape for attesting on-chain payments.
