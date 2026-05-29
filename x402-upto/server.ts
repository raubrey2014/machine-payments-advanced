import express from "express";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import Stripe from "stripe";

const stripe = process.env.STRIPE_CONNECTED === "true"
  ? new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-03-04.preview" as Stripe.LatestApiVersion,
    })
  : null;

const PAY_TO = process.env.PAY_TO_ADDRESS ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NETWORK = process.env.NETWORK ?? "eip155:84532"; // Base Sepolia
const MAX_PRICE = "$0.10"; // Client authorizes up to 10¢ per request

// ─── x402 setup ─────────────────────────────────────────────────────────────

const facilitatorClient = new HTTPFacilitatorClient({
  url: process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
});

const server = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new UptoEvmScheme());

const app = express();
app.use(express.json());

app.use(
  paymentMiddleware(
    {
      "POST /api/resource": {
        accepts: [
          {
            scheme: "upto",
            price: MAX_PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
        ],
        description: "Usage-based resource — billed by actual consumption",
        mimeType: "application/json",
      },
    },
    server,
  ),
);

// ─── Route handler ──────────────────────────────────────────────────────────

app.post("/api/resource", async (req, res) => {
  // ── Your business logic here ──
  // Do some work, determine actual cost...
  const actualCostAtomic = 31200; // e.g. $0.0312 in 6-decimal USDC

  // Settle only the actual usage (not the max authorized)
  setSettlementOverrides(res, { amount: String(actualCostAtomic) });

  // ── Stripe: record the settled amount ──
  // After x402 settles on-chain, create a PI for the captured amount only.
  const paymentResponse = res.getHeader("payment-response") as string | undefined;
  if (paymentResponse && stripe) {
    try {
      const parsed = JSON.parse(Buffer.from(paymentResponse, "base64").toString());
      const txHash = parsed.txHash ?? parsed.transaction_hash;

      if (txHash) {
        const amountInCents = Math.floor(actualCostAtomic / 10_000);
        await stripe.paymentIntents.create(
          {
            amount: amountInCents,
            currency: "usd",
            mode: "transaction_verification",
            transaction_verification_options: {
              transaction_hash: txHash,
              network: "base",
            },
            confirm: true,
          } as any,
          { idempotencyKey: txHash },
        );
        console.log(`Stripe PI: ${amountInCents}¢ for tx ${txHash}`);
      }
    } catch {}
  }

  res.json({ result: "done", settledAtomic: actualCostAtomic });
});

const PORT = process.env.PORT ?? 3004;
app.listen(PORT, () => {
  console.log(`x402 Upto Gateway running on http://localhost:${PORT}`);
  console.log(`  POST /api/resource — 402 → authorize max → settle actual → Stripe PI`);
});
