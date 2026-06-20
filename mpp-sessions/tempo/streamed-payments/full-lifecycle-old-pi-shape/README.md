# MPP Sessions — Full Lifecycle, Old PI Shape (Not Viable)

> **Conclusion: this approach is incompatible with MPP sessions.** See below.

Exploratory demo investigating whether MPP sessions could use the old `payment_method_types: ["tempo_channel"]` PI shape instead of `mode: "transaction_verification"`.

## Why it doesn't work

The old PI shape relies on Stripe's async on-chain listener: Stripe monitors the blockchain for a transaction that **exactly matches** the PI amount, then auto-confirms the PI when it finds one. There is no server-side `confirm()` call — confirmation is fully driven by Stripe's infrastructure.

MPP sessions are fundamentally incompatible with this:

1. **Variable settlement amounts.** The on-chain settle transaction carries the accumulated charges from the session (tokens × price), not a fixed amount known at PI creation time. Stripe can't match a PI with `amount: X` against a settlement of `amount: Y`.

2. **No amount relay mechanism.** To make this work you'd need to embed the PI ID (or some correlation token) in the on-chain transaction metadata so Stripe's listener could look up the right PI regardless of amount. That would require changes to how Tempo encodes transaction data and to Stripe's matching logic — not something the server can do unilaterally.

3. **The `confirm()` call is not part of this flow.** In the old shape Stripe owns confirmation. The server calling `PI.confirm()` after close would either fail (already confirmed by Stripe) or be the wrong path entirely (Stripe never saw the on-chain deposit because it went to the server wallet, not the Stripe deposit address).

## The address divergence problem

Even before the amount-matching issue, there's a structural problem: mppx sets the channel `recipient` at init time. The client opens a Tempo channel to the **server wallet**, not to the **Stripe-generated deposit address**. Stripe's listener never sees the deposit at all.

A `/v1/session/init` pre-flight endpoint is scaffolded below to show the escape hatch (create PI first, return deposit address to client, client opens channel to that address). But even with that wired up, the amount-matching problem remains unsolvable without deeper protocol changes.

## Verdict

Use `mode: "transaction_verification"` (see `../full-lifecycle`). That shape is designed for exactly this: the server confirms the PI explicitly after settlement, passing the actual on-chain tx hash as proof. It doesn't depend on Stripe's async amount-matching infrastructure at all.

## Stack

- **[mppx](https://mpp.dev)** — per-token SSE charging
- **Tempo** — payment channel network (PathUSD testnet)
- **OpenAI** — upstream LLM
- **Stripe** — `payment_method_types: ["tempo_channel"]` PI (old shape)

## Run

```bash
cp .env.example .env  # fill in values
npm run server        # gateway on :3000
npm run client        # test client (uses normal mppx 402 flow — pre-flight not wired)
```
