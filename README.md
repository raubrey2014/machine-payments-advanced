# Machine payments demos

Exploring [MPP](https://mpp.dev) payment flows with Stripe integration at varying depths.

## Naming convention

Each demo folder encodes two things:

1. **Stripe integration depth** — `just-paymentintent` (standalone PI as ledger entry) vs `stripe-billing` (real Subscription/Invoice objects with full billing lifecycle)
2. **Who drives payment / when** — `driven-by-tempo` (client must sign), `driven-by-stripe` (Stripe auto-settles), `on-session-close` (PI on close), `on-capture` (PI on settlement)

## Demos

| Demo | Why | Stripe Shape | Who Drives |
|------|-----|---|---|
| [mpp-sessions](mpp-sessions/) | Variable workloads — pay per unit as you consume (streaming tokens, API calls) | PI on session close | Client (per-token vouchers) |
| [mpp-auth-and-capture](mpp-auth-and-capture/) | Variable workloads or separating payment from fulfillment — authorize upfront, capture what's actually used later | PI full lifecycle (auth + captures) | Server (authorizedSigner) |
| [mpp-subscriptions](mpp-subscriptions/) | Recurring access — pay periodically for ongoing service | PI, Subscription, or full Billing | Client or Stripe (see variants) |
| [x402-upto](x402-upto/) | Variable workloads — authorize a max per-request, settle only actual usage | PI on settlement (actual usage only) | x402 facilitator settles on-chain |

## The spectrum

From least to most Stripe involvement:

```
just-paymentintent          →  Stripe is a ledger. One PI per settlement, that's it.
stripe-billing-driven-by-X  →  Stripe tracks the billing lifecycle (Subscriptions,
                               Invoices, MRR, portal). Who drives payment depends on X.
spt                         →  Stripe IS the payment rail. Standard Billing, card charged.
```
