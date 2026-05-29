# MPP Subscriptions Demo

Recurring subscription payments via MPP, exploring two payment methods and their Stripe integration options.

## Naming convention

The folder names encode two decisions:

1. **Stripe integration depth** — `just-paymentintent` (standalone PIs, no billing lifecycle) vs `stripe-billing` (real Subscription object with invoices, metrics, portal)
2. **Who drives renewal** — `driven-by-tempo` (the client must be online to sign a tx each period) vs `driven-by-stripe` (Stripe owns the cron — it auto-charges or auto-settles without client participation)

These are independent axes. You can have deep Stripe Billing integration with Tempo still driving renewals (client signs, server marks invoice paid). Or you can have Stripe drive renewals on-chain (Stripe is the TIP-1034 operator, signs vouchers on a schedule).

## Structure

```
mpp-subscriptions/
├── tempo/                                      # Payment method: Tempo (on-chain)
│   ├── just-paymentintent-driven-by-tempo/     #   → Tempo drives renewals, standalone PIs as ledger
│   ├── stripe-billing-driven-by-tempo/         #   → Tempo drives renewals, Stripe Subscription as reporting shell
│   └── stripe-billing-driven-by-stripe/        #   → Stripe as operator, auto-settles on-chain each period
└── spt/                                        # Payment method: Stripe SPT (card/Link)
    └── stripe-billing-driven-by-stripe/        #   → SPT activates Subscription, Stripe auto-charges on schedule
```

## Comparison

| | just-paymentintent-driven-by-tempo | stripe-billing-driven-by-tempo | stripe-billing-driven-by-stripe | SPT |
|---|---|---|---|---|
| **Who charges each period** | Client signs a tx | Client signs a tx | Stripe settles on-chain | Stripe charges card |
| **Client online for renewal** | Required | Required | Not required | Not required |
| **Stripe object** | Individual PIs | Subscription (`send_invoice`) | Subscription (`charge_automatically`) | Subscription (`charge_automatically`) |
| **Dunning** | None | Invoice reminders only | Stripe retries on-chain | Stripe retries card |
| **MRR / metrics** | Build from PI metadata | Native | Native | Native |
| **Human portal** | None | Yes | Yes | Yes |

## The spectrum

From least to most Stripe involvement:

1. **just-paymentintent-driven-by-tempo** — Tempo does everything, Stripe just records each payment as a PI. No subscription object, no billing lifecycle.
2. **stripe-billing-driven-by-tempo** — Tempo drives renewals, Stripe Subscription tracks the billing cycle but can't auto-charge (`send_invoice`). Gives you reporting + human portal.
3. **stripe-billing-driven-by-stripe** — Payer opens a channel with Stripe as operator. Stripe auto-settles on-chain each period via `charge_automatically`. Full Billing stack, on-chain settlement.
4. **spt** — Pure Stripe. SPT activates a subscription, card gets charged. Standard Billing, just initiated via MPP.

## Which to use

**just-paymentintent-driven-by-tempo** — Pure machine-to-machine, no humans, minimal Stripe coupling. Just an audit trail.

**stripe-billing-driven-by-tempo** — There's a human who wants a billing dashboard, but the agent/client drives payment timing. Portal escape hatch without making Stripe the operator.

**stripe-billing-driven-by-stripe** — Best of both worlds for on-chain: instant settlement + auto-renewal + full Billing stack + human escape hatch. Requires Stripe to support being a Tempo operator.

**spt** — The subscriber has a card or Link account. Strongest human escape hatch, most familiar UX. Standard Stripe, just initiated via MPP.

## What's real vs. faked

Every demo uses `as any` casts to bypass TypeScript where it references API parameters that don't exist yet. Here's what's real and what's aspirational in each:

### `tempo/just-paymentintent-driven-by-tempo`

| Thing | Status | Notes |
|---|---|---|
| `mppx` subscription middleware | **Real** | Works today via the mppx library |
| `tempo.subscription()` hooks (activated/renewed) | **Real** | Fires on channel events |
| `mode: "transaction_verification"` on PaymentIntent | **Faked** | Not a real PI mode. Aspirational: Stripe verifies an on-chain tx and records it as a PI |
| `transaction_verification_options.network: "tempo"` | **Faked** | No such field exists |
| Stripe connection is optional (`STRIPE_CONNECTED`) | **Real** | Demo runs without Stripe |

### `tempo/stripe-billing-driven-by-tempo`

| Thing | Status | Notes |
|---|---|---|
| `mppx` subscription middleware | **Real** | |
| `stripe.subscriptions.create` with `send_invoice` | **Real** | Standard Billing API |
| `stripe.invoices.pay` with `paid_out_of_band: true` | **Real** | Marks invoice paid externally |
| `mode: "transaction_verification"` on PaymentIntent | **Faked** | Same as above — aspirational tx verification |
| The PI + `paid_out_of_band` combo | **Faked pattern** | Creating a PI for verification and then separately marking the invoice paid out-of-band is a workaround. In reality you'd want the PI to actually _pay_ the invoice, or not create a PI at all |

### `tempo/stripe-billing-driven-by-stripe`

| Thing | Status | Notes |
|---|---|---|
| `mppx` subscription middleware | **Real** | |
| `operator: "stripe"` on tempo.subscription() | **Faked** | mppx doesn't support this concept today |
| `payment_method_types: ["tempo_channel"]` | **Faked** | Not a real Stripe payment method type. Pure fiction. |
| `save_default_payment_method: "on_subscription"` | **Real** | Real parameter, but meaningless with a fake PMT |
| `collection_method: "charge_automatically"` | **Real** | Real parameter, but would fail because there's no valid payment method |
| Stripe as TIP-1034 operator (auto-settling on-chain) | **Faked concept** | The entire model of Stripe acting as an on-chain operator is aspirational |

### `spt/stripe-billing-driven-by-stripe`

| Thing | Status | Notes |
|---|---|---|
| mppx-like 402 challenge middleware | **Faked** | Hand-rolled to simulate what `mppx` would do for Stripe-native payments. Not using the real library. |
| `default_shared_payment_token: spt` on Subscription | **Faked** | Not a real Stripe Subscription parameter (today). Aspirational: attach an SPT as the payment source for recurring charges |
| `stripe.subscriptions.create` / `retrieve` / `update` | **Real** | Standard Billing API (minus the fake param) |
| `cancel_at_period_end` | **Real** | Standard cancellation |
| The 402 challenge format | **Aspirational** | Loosely follows paymentauth.org shape but the `method: "stripe"` / `intent: "subscription"` fields are invented |

## Summary of faked Stripe API surface

These are the specific parameters/modes that don't exist in the Stripe API today:

- **`mode: "transaction_verification"`** — A PaymentIntent mode that would verify an external transaction hash
- **`transaction_verification_options`** — Field to specify network + tx hash for verification
- **`payment_method_types: ["tempo_channel"]`** — A payment method type representing a Tempo state channel
- **`default_shared_payment_token`** — Attaching an SPT directly to a Subscription for recurring billing
- **`operator: "stripe"`** on mppx — The concept of Stripe acting as a TIP-1034 channel operator
