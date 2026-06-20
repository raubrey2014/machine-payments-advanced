# MPP Sessions

Session-based payments where the client deposits a lump sum upfront and pays incrementally per unit (token, request, etc.) via off-chain vouchers. The channel settles on-chain when closed, returning any unspent deposit.

## Structure

```
mpp-sessions/
└── tempo/
    ├── streamed-payments/          # SSE-based, per-token billing during a continuous stream
    │   └── full-lifecycle/
    └── pay-as-you-go/              # Plain HTTP, per-request billing
        └── full-lifecycle/
```

## Two session patterns

### Streamed payments (`streamed-payments/`)

The server opens a persistent SSE connection and charges per token as content is yielded. The client uses `session.sse()`. Good for LLM token streams and live data feeds.

See guide: https://mpp.dev/guides/streamed-payments

### Pay-as-you-go (`pay-as-you-go/`)

Each request is an independent HTTP call charged via `mppx.session()` middleware. The channel is opened on the first request and reused across many calls. The client uses `session.fetch()`. Good for photo APIs, search, or any per-call billing.

See guide: https://mpp.dev/guides/pay-as-you-go

## Stripe integration

See `API-REVIEW.md` for the full design discussion on how to model the session lifecycle in Stripe PaymentIntents.
