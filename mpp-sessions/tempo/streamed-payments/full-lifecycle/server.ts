import crypto from "crypto";
import express from "express";
import { Mppx, tempo } from "mppx/express";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Stripe stub — the transaction_verification PI shape doesn't exist yet.
// These log what the real calls would do when the API ships.
//
// Known gaps to resolve before shipping top-up support:
//   - incrementAuthorization: works on standard manual-capture PIs but is not
//     documented for transaction_verification PIs. Confirm whether the preview API
//     supports both on the same PI — if not, each top-up deposit may need its own PI.
//   - The combination of capture_method:"manual" + transaction_verification_options
//     is untested; validate in a Stripe sandbox before enabling in production.
const stripe = {
  paymentIntents: {
    create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      const id = `pi_stub_${crypto.randomUUID().slice(0, 8)}`;
      console.log("[stripe stub] paymentIntents.create", JSON.stringify({ ...params, _idempotencyKey: opts?.idempotencyKey }));
      return { id };
    },
    capture: async (id: string, params: Record<string, unknown>) => {
      console.log("[stripe stub] paymentIntents.capture", id, JSON.stringify(params));
      return { id, status: "succeeded" };
    },
    confirm: async (id: string) => {
      console.log("[stripe stub] paymentIntents.confirm", id);
      return { id, status: "succeeded" };
    },
    incrementAuthorization: async (id: string, params: Record<string, unknown>) => {
      console.log("[stripe stub] paymentIntents.incrementAuthorization", id, JSON.stringify(params));
      return { id, status: "requires_capture" };
    },
  },
};

// Fields mppx exposes at runtime on SessionReceipt but not on the base Receipt type.
type SessionReceiptExtras = {
  txHash?: `0x${string}`;
  channelId?: string;
  depositAmount?: string;      // PathUSD units (6 decimals) deposited at channel open
  acceptedCumulative?: string; // PathUSD units settled at channel close
};

// $0.0001 per token = 1¢ per 100 tokens
const PRICE_PER_TOKEN = "0.0001";

// Tracks open PaymentIntent IDs and their current authorized amount keyed by channelId.
// authorizedCents grows on each top-up so we can pass the new total to incrementAuthorization.
// In production, persist this in a database — an in-memory map is lost on restart.
const pendingPaymentIntents = new Map<string, { piId: string; authorizedCents: number }>();

// Secret
const secretKey = crypto.randomBytes(32).toString("base64");

const mppx = Mppx.create({
  secretKey: secretKey,
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

  // At session open: authorize a PI for the full escrowed deposit amount.
  // capture_method: "manual" holds the authorization open — funds are not moved yet.
  // This mirrors the hotel model: auth at check-in for the deposit, capture actual spend at checkout.
  if (payload?.action === "open") {
    if (!channelId || !sr.depositAmount) return;

    const depositInCents = Number(BigInt(sr.depositAmount) * 100n / 1_000_000n);

    const pi = await stripe.paymentIntents.create(
      {
        amount: depositInCents,
        currency: "usd",
        capture_method: "manual",
        metadata: { channelId, network: "tempo" },
      } as any,
      { idempotencyKey: `open-${channelId}` },
    );

    pendingPaymentIntents.set(channelId, { piId: pi.id, authorizedCents: depositInCents });
    console.log(`Stripe PI authorized: ${depositInCents}¢ (escrowed deposit) for channel ${channelId}`);
    return;
  }

  // At top-up: the client has deposited more on-chain, so extend the Stripe authorization
  // to cover the new total. additionalDeposit lives on the credential payload, not the receipt.
  if (payload?.action === "topUp") {
    const additionalDeposit = (credential as any)?.payload?.additionalDeposit as string | undefined;
    if (!channelId || !additionalDeposit) return;

    const additionalCents = Number(BigInt(additionalDeposit) * 100n / 1_000_000n);
    const entry = pendingPaymentIntents.get(channelId);
    if (!entry) return; // no PI found — server restarted mid-session, nothing to increment

    const newTotal = entry.authorizedCents + additionalCents;
    await stripe.paymentIntents.incrementAuthorization(entry.piId, { amount: newTotal });
    pendingPaymentIntents.set(channelId, { piId: entry.piId, authorizedCents: newTotal });
    console.log(`Stripe PI incremented: +${additionalCents}¢ → ${newTotal}¢ total for channel ${channelId}`);
    return;
  }

  // At session close: capture the PI for the actual settled amount (≤ the authorized
  // deposit). Using capture with amount_to_capture preserves the original authorized
  // amount on the PI so both the deposit and the actual spend are visible.
  if (payload?.action === "close") {
    if (!sr.txHash || !sr.acceptedCumulative) return;

    const amountInCents = Number(BigInt(sr.acceptedCumulative) * 100n / 1_000_000n);
    const entry = channelId ? pendingPaymentIntents.get(channelId) : undefined;
    const piId = entry?.piId;

    if (piId) {
      await stripe.paymentIntents.capture(
        piId,
        {
          amount_to_capture: amountInCents,
          transaction_verification_options: {
            transaction_hash: sr.txHash,
            network: "tempo",
          },
        } as any,
      );
      if (channelId) pendingPaymentIntents.delete(channelId);
      console.log(`Stripe PI captured: ${amountInCents}¢ for settle tx ${sr.txHash}`);
    } else {
      // Fallback: no open PI found (server restarted mid-session).
      await stripe.paymentIntents.create(
        {
          amount: amountInCents,
          currency: "usd",
          mode: "transaction_verification",
          transaction_verification_options: {
            transaction_hash: sr.txHash,
            network: "tempo",
          },
          confirm: true,
        } as any,
        { idempotencyKey: sr.txHash },
      );
      console.log(`Stripe PI created at close (fallback): ${amountInCents}¢ for settle tx ${sr.txHash}`);
    }
  }
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
