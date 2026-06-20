import crypto from "crypto";
import express from "express";
import { Mppx, tempo } from "mppx/express";
import OpenAI from "openai";
import Stripe from "stripe";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-03-04.preview" as Stripe.LatestApiVersion,
});

// Fields mppx exposes at runtime on SessionReceipt but not on the base Receipt type.
type SessionReceiptExtras = {
  txHash?: `0x${string}`;
  channelId?: string;
  depositAmount?: string;      // PathUSD units (6 decimals) deposited at channel open
  acceptedCumulative?: string; // PathUSD units settled at channel close
};

// $0.0001 per token = 1¢ per 100 tokens
const PRICE_PER_TOKEN = "0.0001";

// Tracks open PaymentIntent IDs keyed by channelId so we can capture at close.
// In production, persist this in a database — an in-memory map is lost on restart.
const pendingPaymentIntents = new Map<string, string>();

// Secret
const secretKey = process.env.MPP_SECRET_KEY ?? crypto.randomBytes(32).toString("base64");

// ─── Core tension with the old PI shape ───────────────────────────────────────
// In the old PI shape (payment_method_types: ["tempo_channel"]), Stripe generates
// a Tempo deposit address when the PI is created. Funds should flow *to that
// Stripe-managed address* — not to the server wallet.
//
// But mppx sets the channel recipient at init time, before any PI exists.
// The two addresses therefore diverge: the client opens a Tempo channel to the
// server wallet, while the PI's deposit address points somewhere else.
//
// Potential escape hatch: a /v1/session/init pre-flight (see below) that creates
// the PI first, returns the Stripe deposit address to the client, and lets the
// client open a channel to THAT address — bypassing the mppx 402 challenge for
// the open step. The mppx session middleware then handles per-token SSE billing
// against the already-open channel.
// ─────────────────────────────────────────────────────────────────────────────

const mppx = Mppx.create({
  secretKey,
  methods: [
    tempo({
      testnet: true,
      currency: "0x20c0000000000000000000000000000000000000", // PathUSD testnet
      recipient: (process.env.RECIPIENT_ADDRESS ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") as `0x${string}`,
      sse: true,
    }),
  ],
});

mppx.onPaymentSuccess(async ({ receipt, credential }) => {
  const payload = (credential as any)?.payload;
  const sr = receipt as typeof receipt & SessionReceiptExtras;
  const channelId = sr.channelId ?? (credential as any)?.channelId;

  // At session open: create a PI using payment_method_types: ["tempo_channel"].
  // Stripe returns a Tempo deposit address in next_action — in the ideal flow the
  // client funds that address. See tension point above for why this currently
  // diverges from the mppx channel recipient.
  if (payload?.action === "open") {
    if (!channelId || !sr.depositAmount) return;

    const depositInCents = Number(BigInt(sr.depositAmount) * 100n / 1_000_000n);

    const pi = await stripe.paymentIntents.create(
      {
        amount: depositInCents,
        currency: "usdc",
        payment_method_types: ["tempo_channel"],
        metadata: { channelId, network: "tempo" },
      } as any,
      { idempotencyKey: `open-${channelId}` },
    );

    // The deposit address Stripe generated for this PI — client should fund this.
    const depositAddress = (pi as any).next_action?.tempo_channel?.deposit_address;
    if (depositAddress) {
      console.log(`Stripe Tempo deposit address: ${depositAddress} (channel ${channelId})`);
    }

    pendingPaymentIntents.set(channelId, pi.id);
    console.log(`Stripe PI created (old shape): ${pi.id} for channel ${channelId}`);
    return;
  }

  // At session close: update the PI to the actual settled amount and confirm.
  // If Stripe already detected the on-chain deposit and confirmed the PI itself,
  // this update/confirm may be redundant — check PI status first in production.
  if (payload?.action === "close") {
    if (!sr.txHash || !sr.acceptedCumulative) return;

    const amountInCents = Number(BigInt(sr.acceptedCumulative) * 100n / 1_000_000n);
    const piId = channelId ? pendingPaymentIntents.get(channelId) : undefined;

    if (piId) {
      await stripe.paymentIntents.update(
        piId,
        { amount: amountInCents } as any,
      );
      await stripe.paymentIntents.confirm(piId);
      if (channelId) pendingPaymentIntents.delete(channelId);
      console.log(`Stripe PI confirmed: ${amountInCents}¢ for settle tx ${sr.txHash}`);
    } else {
      // Fallback: no open PI found (server restarted mid-session).
      await stripe.paymentIntents.create(
        {
          amount: amountInCents,
          currency: "usdc",
          payment_method_types: ["tempo_channel"],
          metadata: { txHash: sr.txHash, network: "tempo" },
          confirm: true,
        } as any,
        { idempotencyKey: sr.txHash },
      );
      console.log(`Stripe PI created at close (fallback): ${amountInCents}¢ for tx ${sr.txHash}`);
    }
  }
});

const app = express();
app.use(express.json());

// Pre-flight: create the PI first, get the Stripe Tempo deposit address, and return
// it to the client so the client can open a Tempo channel to THAT address.
// This is the path that would make the old PI shape work end-to-end — the client
// skips the normal mppx 402 challenge for channel-open and uses this address instead.
app.post("/v1/session/init", async (req, res) => {
  const { depositAmount } = req.body as { depositAmount: string };
  const channelId = crypto.randomUUID();
  const depositInCents = Number(BigInt(depositAmount) * 100n / 1_000_000n);

  const pi = await stripe.paymentIntents.create(
    {
      amount: depositInCents,
      currency: "usdc",
      payment_method_types: ["tempo_channel"],
      metadata: { channelId, network: "tempo" },
    } as any,
    { idempotencyKey: `init-${channelId}` },
  );

  const depositAddress = (pi as any).next_action?.tempo_channel?.deposit_address ?? null;

  pendingPaymentIntents.set(channelId, pi.id);

  res.json({
    channelId,
    paymentIntentId: pi.id,
    // Client opens a Tempo channel to this address, not the server wallet.
    depositAddress,
  });
});

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
  console.log(`Endpoints:`);
  console.log(`  POST /v1/session/init         — get Stripe deposit address before opening channel`);
  console.log(`  POST /v1/chat/completions     — stream completions (per-token billing)`);
});
