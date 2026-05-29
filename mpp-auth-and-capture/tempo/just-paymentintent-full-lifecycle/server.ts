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
    // tempo.authorize() — hypothetical API for the authorize intent.
    // Unlike tempo.session(), the server holds the authorizedSigner key
    // and can capture against the authorization without further client interaction.
    tempo.authorize({
      testnet: true,
      currency: "0x20c0000000000000000000000000000000000000", // PathUSD testnet
      recipient: (process.env.RECIPIENT_ADDRESS ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") as `0x${string}`,
      // The server controls this key — it signs vouchers to capture funds
      // without requiring the client to be online or participate.
      authorizedSignerKey: process.env.AUTHORIZED_SIGNER_KEY as `0x${string}`,
    }),
  ],
});

// After a capture settles on-chain, record it in Stripe via transaction_verification.
mppx.onPaymentSuccess(async ({ receipt }) => {
  if (!stripe) return;
  if (!receipt.txHash) return;

  const amountInCents = Number(BigInt(receipt.capturedAmount) * 100n / 1_000_000n);

  await stripe.paymentIntents.create(
    {
      amount: amountInCents,
      currency: "usd",
      mode: "transaction_verification",
      transaction_verification_options: {
        transaction_hash: receipt.txHash,
        network: "tempo",
      },
      confirm: true,
    } as any,
    { idempotencyKey: receipt.txHash },
  );

  console.log(`Stripe PI recorded: ${amountInCents}¢ for tx ${receipt.txHash}`);
});

const app = express();
app.use(express.json());

// Authorize endpoint: client pre-authorizes up to 5 PathUSD.
// The mppx.authorize() middleware:
//   1. Issues a 402 with intent="authorize", amount=5000000
//   2. Client signs a TIP-1034 open transaction funding the channel
//   3. Server broadcasts the open tx, confirms the channel is live
//   4. Returns an authorization handle the route can capture against
app.post(
  "/v1/chat/completions",
  mppx.authorize({
    amount: AUTHORIZE_AMOUNT,
    authorizationExpires: () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }),
  async (req, res) => {
    // After authorization succeeds, req.authorization is a capture handle.
    // The server can capture incrementally — no further client interaction needed.
    const auth = req.authorization!;

    const upstream = await openai.chat.completions.create({
      ...req.body,
      stream: true,
    } as OpenAI.ChatCompletionCreateParamsStreaming);

    // Stream response, capturing per-token as we go
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");

    let tokenCount = 0;
    for await (const chunk of upstream) {
      const content = chunk.choices[0]?.delta?.content;
      if (!content) continue;

      tokenCount++;
      // Capture per-token against the authorization.
      // The server signs a voucher with its authorizedSigner key and
      // advances the cumulative captured amount. No client round-trip.
      await auth.capture({ amount: PRICE_PER_TOKEN });

      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    // Optionally settle on-chain now, or let it accumulate and settle later
    console.log(`Captured ${tokenCount} tokens (${auth.capturedAmount} PathUSD units)`);

    res.write("data: [DONE]\n\n");
    res.end();
  },
);

// Non-streaming: capture a fixed amount per request
app.post(
  "/v1/generate",
  mppx.authorize({
    amount: AUTHORIZE_AMOUNT,
    authorizationExpires: () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }),
  async (req, res) => {
    const auth = req.authorization!;

    const result = await openai.chat.completions.create({
      ...req.body,
      stream: false,
    } as OpenAI.ChatCompletionCreateParams);

    // Capture based on actual token usage
    const tokensUsed = result.usage?.total_tokens ?? 0;
    const captureAmount = BigInt(tokensUsed) * BigInt(Math.round(Number(PRICE_PER_TOKEN) * 1_000_000));
    await auth.capture({ amount: captureAmount.toString() });

    console.log(`Captured for ${tokensUsed} tokens: ${captureAmount} PathUSD units`);
    res.json(result);
  },
);

// Void endpoint: release remaining authorization back to the payer
app.post("/v1/authorizations/:authId/void", async (req, res) => {
  const { authId } = req.params;

  // Void = TIP-1034 close(descriptor, settled, settled, "0x")
  // Releases uncaptured deposit back to payer, no further captures possible.
  await mppx.void(authId);

  console.log(`Voided authorization ${authId}`);
  res.json({ authorizationId: authId, status: "voided" });
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`Auth+Capture Gateway running on http://localhost:${PORT}`);
  console.log();
  console.log(`Flow:`);
  console.log(`  1. Client POSTs → gets 402 with intent="authorize", amount=${AUTHORIZE_AMOUNT}`);
  console.log(`  2. Client signs TIP-1034 open tx → server broadcasts → authorization active`);
  console.log(`  3. Server captures per-token via authorizedSigner vouchers`);
  console.log(`  4. Server voids remaining or settles on-chain → Stripe PI recorded`);
});
