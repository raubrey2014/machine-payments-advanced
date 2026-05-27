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

// Fields mppx exposes at runtime on SessionReceipt but not on the base Receipt type.
type SessionReceiptExtras = {
  txHash?: `0x${string}`;
  acceptedCumulative: string;
};

// $0.0001 per token = 1¢ per 100 tokens
const PRICE_PER_TOKEN = "0.0001";

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY ?? crypto.randomBytes(32).toString("base64"),
  methods: [
    tempo({
      testnet: true,
      currency: "0x20c0000000000000000000000000000000000000", // PathUSD testnet
      recipient: (process.env.RECIPIENT_ADDRESS ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") as `0x${string}`,
      sse: true,
    }),
  ],
});

// On close: the channel is finalized and funds settle on-chain.
// Create a Stripe PaymentIntent for the settled amount as a record of the on-chain payment.
mppx.onPaymentSuccess(async ({ receipt, credential }) => {
  const payload = (credential as any)?.payload;
  if (payload?.action !== "close") return;

  if (!stripe) return;

  const sr = receipt as typeof receipt & SessionReceiptExtras;
  if (!sr.txHash) return;

  // acceptedCumulative is raw PathUSD units (6 decimals). Convert to cents.
  const amountInCents = Number(BigInt(sr.acceptedCumulative) * 100n / 1_000_000n);

  await stripe.paymentIntents.create(
    {
      amount: amountInCents,
      currency: "usd",
      payment_method_data: {
        type: "crypto",
        transaction_hash: sr.txHash,
        network: "tempo",
      } as any,
      confirm: true,
    },
    { idempotencyKey: sr.txHash },
  );

  console.log(`Stripe PI created: ${amountInCents}¢ for settle tx ${sr.txHash}`);
});

const app = express();
app.use(express.json());

app.post(
  "/v1/chat/completions",
  mppx.session({ amount: PRICE_PER_TOKEN, unitType: "token" }),
  async (req, _res) => {
    const upstream = await openai.chat.completions.create({
      ...req.body,
      stream: true,
    } as OpenAI.ChatCompletionCreateParamsStreaming);

    return async function* (stream: { charge: () => Promise<void> }) {
      for await (const chunk of upstream) {
        const content = chunk.choices[0]?.delta?.content;
        if (!content) continue;
        await stream.charge();
        yield JSON.stringify(chunk);
      }
    };
  },
);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`AI Gateway running on http://localhost:${PORT}`);
  console.log(`Endpoint: POST http://localhost:${PORT}/v1/chat/completions`);
});
