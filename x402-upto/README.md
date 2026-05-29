# x402 Upto + Stripe Transaction Verification

An AI gateway using x402's `upto` scheme for usage-based billing, with Stripe recording each settled payment via `transaction_verification`.

## How x402 upto works

The client authorizes a **max** amount, the server settles only what was actually used:

```
Client                          Server                    x402 Facilitator    Stripe
  |                               |                            |                |
  |  POST /v1/chat/completions    |                            |                |
  |------------------------------>|                            |                |
  |                               |                            |                |
  |  402 Payment Required         |                            |                |
  |  scheme="upto", price=$0.10   |                            |                |
  |<------------------------------|                            |                |
  |                               |                            |                |
  |  SDK signs max authorization  |                            |                |
  |  PAYMENT-SIGNATURE: <signed>  |                            |                |
  |------------------------------>|                            |                |
  |                               |  Generate response          |                |
  |                               |  Tokens used: 312           |                |
  |                               |  Actual cost: $0.0312       |                |
  |                               |                            |                |
  |                               |  setSettlementOverrides     |                |
  |                               |  amount: "31200" (atomic)   |                |
  |                               |                            |                |
  |                               |  Settle actual amount       |                |
  |                               |--------------------------->|                |
  |                               |                            |                |
  |                               |  PAYMENT-RESPONSE (txHash) |                |
  |                               |<---------------------------|                |
  |                               |                            |                |
  |                               |  Create PI for settled amt  |                |
  |                               |---------------------------------------------->|
  |                               |                            |                |
  |  200 OK + result              |                            |                |
  |  PAYMENT-RESPONSE header      |                            |                |
  |<------------------------------|                            |                |
```

## How this connects to Stripe

After x402 settles the actual usage amount on-chain, the server creates a Stripe PaymentIntent with `transaction_verification`:

```ts
await stripe.paymentIntents.create({
  amount: settledAmountInCents,
  currency: "usd",
  mode: "transaction_verification",
  transaction_verification_options: {
    transaction_hash: txHashFromFacilitator,
    network: "base",
  },
  confirm: true,
});
```

Key: the PI is created **only for the captured amount** (actual usage), not the max authorized. If the client authorized $0.10 but only used $0.03 worth of tokens, the PI is for $0.03.

## Comparison with MPP authorize

| | x402 upto | MPP authorize (Tempo) | MPP authorize (SPT) |
|---|---|---|---|
| **Authorization** | Client signs max via PAYMENT-SIGNATURE | Client opens TIP-1034 channel | Client creates SPT |
| **Settlement** | Facilitator settles actual on-chain | Server signs voucher, settles on-chain | Server captures on PI |
| **Scope** | Per-request (auth + settle in one round-trip) | Per-authorization (multiple captures) | Per-authorization (multiple captures) |
| **Overpay risk** | None — facilitator settles exact amount | None — server captures exact amount | None — server captures exact amount |
| **Multi-request reuse** | No — new auth per request | Yes — one auth, many captures | Yes — one auth, many captures |
| **Protocol** | x402 (402 + headers) | MPP (402 + Payment auth scheme) | MPP (402 + Payment auth scheme) |

## When to use x402 upto vs MPP authorize

**x402 upto** — Each request is independent. Client authorizes a max per-request, settles actual per-request. Simple, stateless, one round-trip. Good for: single API calls with variable cost.

**MPP authorize** — Client authorizes once for multiple requests. Server captures incrementally. Good for: sessions, multi-step workflows, metered billing over time.

## Setup

```bash
npm install

export OPENAI_API_KEY="sk-..."
export PAY_TO_ADDRESS="0x..."
export FACILITATOR_URL="https://x402.org/facilitator"
export STRIPE_SECRET_KEY="sk_test_..."
export STRIPE_CONNECTED="true"

npm run server
```

Client (using x402 SDK):

```ts
import { x402Client } from "@x402/fetch";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const client = new x402Client();
client.register("eip155:*", new UptoEvmScheme(signer));

const response = await client.fetch("http://localhost:3004/v1/chat/completions", {
  method: "POST",
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hello" }],
  }),
  headers: { "Content-Type": "application/json" },
});
```
