# MPP Auth + Capture Demo

Authorize-and-capture payments where the client pre-authorizes a max amount and the server captures autonomously.

## Structure

```
mpp-auth-and-capture/
├── tempo/
│   ├── just-paymentintent-full-lifecycle/   # PI created at auth, captures tracked against it
│   └── just-paymentintent-on-capture/       # No PI at auth — PI created only when funds settle
└── spt/
    └── just-paymentintent-full-lifecycle/   # SPT → manual-capture PI at auth, server captures against it
```

## Tempo: full-lifecycle vs on-capture

| | full-lifecycle | on-capture |
|---|---|---|
| **PI at authorization** | Yes — created immediately to represent the hold | No — channel open is invisible to Stripe |
| **PI at capture/settle** | Updated / captured against | Created fresh with `transaction_verification` |
| **PI on void** | Canceled (releases hold) | None — nothing happened in Stripe |
| **When Stripe knows** | Immediately on auth | Only when money actually moves |
| **Analogy** | Card auth hold shows on statement | No pending charge until settlement |

### When to use which

**full-lifecycle** — when you want Stripe to reflect the authorization as it happens. Useful if you're tracking outstanding holds, reporting on authorization-to-capture rates, or the human needs to see "pending" charges.

**on-capture** — when you only care about settled payments. Simpler — Stripe only sees confirmed on-chain settlements. No phantom holds, no canceled PIs cluttering the dashboard. The channel open/close is purely a Tempo concern.

## SPT: full-lifecycle

With SPTs, `full-lifecycle` is the natural (and only real) option because the PI IS the authorization — `capture_method: "manual"` creates a hold on the card network. You can't "not create a PI" and still have an auth with Stripe.
