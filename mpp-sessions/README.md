# MPP Sessions Demo

Session-based streaming payments where the client pays per-token as content is delivered.

## Structure

```
mpp-sessions/
└── tempo/
    └── just-paymentintent-on-session-close/   # Tempo sessions, PI created on channel close
```

## Naming

- **just-paymentintent** — Stripe integration is a single PI recording the total session spend
- **on-session-close** — the PI is created when the channel closes (not per-token)

## How it works

The client opens a Tempo channel, streams tokens, sends incremental vouchers as it consumes content, then closes the session. On close, the server creates a Stripe PaymentIntent with `transaction_verification` to record the total on-chain settlement.

Stripe sees one PI per session — not per token. The on-chain settlement is the source of truth; the PI is a verified ledger entry.
