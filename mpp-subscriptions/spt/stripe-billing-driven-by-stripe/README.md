# MPP Subscriptions via Shared Payment Tokens (SPT)

Subscriptions where the client provides a recurring-capable SPT, and Stripe handles everything after that — billing, renewals, dunning, the works.

## How It Works

The client creates a recurring SPT and sends it once. The server passes it directly to `POST /v1/subscriptions` with `default_shared_payment_token`. Stripe extracts the payment method, creates the subscription, and auto-charges on schedule. Done.

```
Client                          Server                         Stripe
  |                               |                               |
  |  GET /api/pro                 |                               |
  |------------------------------>|                               |
  |                               |                               |
  |  402 Payment Required         |                               |
  |  method="stripe"              |                               |
  |  intent="subscription"        |                               |
  |<------------------------------|                               |
  |                               |                               |
  |  Client creates recurring SPT |                               |
  |  (via Stripe client flow,     |                               |
  |   Link CLI, etc.)             |                               |
  |-------------------------------------------------------------->|
  |                           spt_xxx                              |
  |<--------------------------------------------------------------|
  |                               |                               |
  |  Authorization: Payment       |                               |
  |  payload: { spt: "spt_xxx" }  |                               |
  |------------------------------>|                               |
  |                               |  POST /v1/subscriptions        |
  |                               |    customer=cus_xxx            |
  |                               |    items[0][price]=price_xxx   |
  |                               |    default_shared_payment_token=spt_xxx
  |                               |------------------------------>|
  |                               |                               |
  |  200 OK (subscribed!)         |       sub_abc active           |
  |<------------------------------|<------------------------------|
  |                               |                               |
  |  ... 1 week later ...         |                               |
  |                               |                               |
  |  (client offline, doesn't     |  Stripe auto-charges           |
  |   need to do anything)        |  invoice.paid fires            |
  |                               |<------------------------------|
  |                               |                               |
  |  GET /api/pro                 |                               |
  |------------------------------>|  Check sub status → active     |
  |  200 OK                       |                               |
  |<------------------------------|                               |
```

## Why not "just payment intent" for SPTs?

With Tempo, you have a choice: record each on-chain payment as a standalone PI, or create a Stripe Subscription and mark invoices paid. That choice exists because Tempo is a separate payment rail — Stripe is just the ledger.

With SPTs, **Stripe is the payment rail**. There's no external settlement to record. You just... use Stripe. The Subscription API handles billing, invoicing, retries, everything. Creating standalone PIs per period would be fighting the API.

## The SPT recurring capability

SPTs now support recurring usage. The shape is:

```bash
stripe post /v1/subscriptions \
  -d customer=cus_xxx \
  -d "items[0][price]=price_xxx" \
  -d default_shared_payment_token=spt_xxx \
  -d "expand[0]=latest_invoice.payment_intent"
```

Stripe extracts the payment method from the SPT and stores it for recurring use. No intermediate PI creation needed, no manual PM extraction. One API call.

## What the human sees

```
Stripe Customer Portal:
┌──────────────────────────────────────────────┐
│ Your subscriptions                           │
│                                              │
│ Pro API Access          $1.00/week           │
│ Next billing date: June 5, 2026             │
│ Payment method: Visa •••• 4242               │
│                                              │
│ [Update payment method]  [Cancel]            │
└──────────────────────────────────────────────┘
```

This is a completely standard Stripe subscription from the human's perspective. They don't need to know it was initiated by an agent via MPP.

## Comparison with Tempo subscriptions

| | Tempo | SPT |
|---|---|---|
| **Client participation** | Signs a tx every period | Signs once (creates SPT) |
| **Auto-renewal** | No | Yes — Stripe charges automatically |
| **Dunning** | None | Stripe retries + emails |
| **Settlement speed** | Instant (on-chain) | Card network (T+2) |
| **Permissionless** | Yes — any wallet | No — needs card/Link |
| **Client offline** | Subscription lapses | Subscription continues |
| **Human escape hatch** | Weak (need wallet to manage) | Strong (standard Stripe portal) |

## What's Real vs. Faked

- **The subscription intent** — [mpp.dev/intents/subscription](https://mpp.dev/intents/subscription) has a guide describing the intent schema (`amount`, `currency`, `periodCount`, `periodUnit`, etc.), but the [IETF spec](https://paymentauth.org/draft-payment-intent-subscription-00) it links to is a 404. No formal spec exists yet.
- **The Stripe method for subscriptions** — There's no `draft-stripe-subscription-00.md` in [mpp-specs](../../mpp-specs/specs/methods/stripe/). Only `authorize` and `charge` exist. This demo imagines what a Stripe subscription method would look like.
- **Stripe method integration on mpp.dev** — The subscription intent page only lists Tempo as a method integration. No Stripe/SPT integration is documented.
- **`default_shared_payment_token` on subscriptions** — This parameter doesn't exist on the Stripe API today. The demo assumes it would work analogously to how SPTs work on PaymentIntents.

## Open Questions

- **How does the agent create a recurring SPT?** It needs access to Stripe client-side flows or Link CLI's spend-request with recurring capability. The challenge must communicate that recurring authorization is needed.
- **Does mppx need a `stripe` payment method?** Yes — this requires `method="stripe"` support in mppx, which doesn't exist yet. The server would need to issue Stripe-method challenges and validate SPT credentials.
- **Can the agent cancel?** Yes — call `DELETE /v1/subscriptions/:id`. Or the human cancels via portal.

## Setup

```bash
npm install

export STRIPE_SECRET_KEY="sk_test_..."
export STRIPE_PRICE_ID="price_..."          # A $1/week recurring price
export STRIPE_NETWORK_ID="profile_..."      # Business Network Profile ID

npm run server
```
