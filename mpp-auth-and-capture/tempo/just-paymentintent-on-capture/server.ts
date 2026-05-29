import crypto from "crypto";
import express from "express";
import { Mppx, tempo } from "mppx/express";
import OpenAI from "openai";
import Stripe from "stripe";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const stripe = process.env.STRIPE_CONNECTED === "true"
  ? new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-03-04.preview" as Stripe.LatestApiVersion,
    })
  : null;

// Auth+Capture pricing
const AUTHORIZE_AMOUNT = "5000000"; // 5 PathUSD max authorization
const PRICE_PER_TOKEN = "0.0001"; // $0.0001 per token captured

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY ?? crypto.randomBytes(32).toString("base64"),
  methods: [
    tempo.authorize({
      testnet: true,
      currency: "0x20c0000000000000000000000000000000000000",
      recipient: (process.env.RECIPIENT_ADDRESS ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") as `0x${string}`,
      authorizedSignerKey: process.env.AUTHORIZED_SIGNER_KEY as `0x${string}`,
    }),
  ],
});

// Only create a Stripe PI when the server actually settles on-chain (capture).
// No PI at auth time — we wait until funds move.
mppx.onCapture(async ({ receipt }) => {
  if (!stripe) return;
  if (!receipt.txHash) return;

  const amountInCents = Number(BigInt(receipt.delta) * 100n / 1_000_000n);

  await stripe.paymentIntents.create(
    {
      amount: amountInCents,
      currency: "usd",
      mode: "transaction_verification",
      transaction_verification_options: {
        transaction_hash: receipt.txHash,
        network: "tempo",
      },
      metadata: {
        authorization_id: receipt.authorizationId,
        captured_amount: receipt.capturedAmount,
        delta: receipt.delta,
      },
      confirm: true,
    } as any,
    { idempotencyKey: receipt.txHash },
  );

  console.log(`Stripe PI created on capture: ${amountInCents}¢ for tx ${receipt.txHash}`);
});

const app = express();
app.use(express.json());

app.post(
  "/v1/chat/completions",
  mppx.authorize({
    amount: AUTHORIZE_AMOUNT,
    authorizationExpires: () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }),
  async (req, res) => {
    const auth = req.authorization!;

    const upstream = await openai.chat.completions.create({
      ...req.body,
      stream: true,
    } as OpenAI.ChatCompletionCreateParamsStreaming);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");

    let tokenCount = 0;
    for await (const chunk of upstream) {
      const content = chunk.choices[0]?.delta?.content;
      if (!content) continue;
      tokenCount++;
      await auth.capture({ amount: PRICE_PER_TOKEN });
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    // Settle on-chain now — this triggers the onCapture hook
    // which creates the Stripe PI with transaction_verification.
    const settleTx = await auth.settle();
    console.log(`Settled ${tokenCount} tokens on-chain: ${settleTx}`);

    res.write("data: [DONE]\n\n");
    res.end();
  },
);

// Void: close channel without settling, no PI created
app.post("/v1/authorizations/:authId/void", async (req, res) => {
  const { authId } = req.params;
  await mppx.void(authId);
  // No Stripe PI — nothing was captured/settled
  console.log(`Voided authorization ${authId} — no PI created`);
  res.json({ authorizationId: authId, status: "voided" });
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`Auth+Capture Gateway (PI on capture only) running on http://localhost:${PORT}`);
  console.log();
  console.log(`Stripe PI creation:`);
  console.log(`  ✗ Authorization — no PI created (just a channel open)`);
  console.log(`  ✓ Capture/Settle — PI created with transaction_verification`);
  console.log(`  ✗ Void — no PI (nothing settled)`);
});
