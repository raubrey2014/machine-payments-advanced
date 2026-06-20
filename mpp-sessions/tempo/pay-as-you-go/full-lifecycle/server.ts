import crypto from "crypto";
import express from "express";
import { Mppx, tempo } from "mppx/express";
import Stripe from "stripe";

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

// $0.01 per request
const PRICE_PER_REQUEST = "0.01";

// Tracks open PaymentIntent IDs and their current authorized amount keyed by channelId.
// authorizedCents grows on each top-up so we can pass the new total to incrementAuthorization.
// In production, persist this in a database — an in-memory map is lost on restart.
const pendingPaymentIntents = new Map<string, { piId: string; authorizedCents: number }>();

const secretKey = process.env.MPP_SECRET_KEY ?? crypto.randomBytes(32).toString("base64");

const mppx = Mppx.create({
  secretKey,
  methods: [
    tempo({
      testnet: true,
      currency: "0x20c0000000000000000000000000000000000000", // PathUSD testnet
      recipient: (process.env.RECIPIENT_ADDRESS ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") as `0x${string}`,
      // No sse: true — pay-as-you-go uses plain HTTP requests, not a persistent SSE stream.
      // Each request carries an off-chain voucher; the channel is opened once and reused.
    }),
  ],
});

// Stripe stub — transaction_verification PI shape doesn't exist yet.
//
// Known gaps to resolve before shipping top-up support:
//   - incrementAuthorization: works on standard manual-capture PIs but is not
//     documented for transaction_verification PIs. Confirm whether the preview API
//     supports both on the same PI — if not, each top-up deposit may need its own PI.
//   - The combination of capture_method:"manual" + transaction_verification_options
//     is untested; validate in a Stripe sandbox before enabling in production.
const stripeStub = {
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
    incrementAuthorization: async (id: string, params: Record<string, unknown>) => {
      console.log("[stripe stub] paymentIntents.incrementAuthorization", id, JSON.stringify(params));
      return { id, status: "requires_capture" };
    },
  },
};

mppx.onPaymentSuccess(async ({ receipt, credential }) => {
  const payload = (credential as any)?.payload;
  const sr = receipt as typeof receipt & SessionReceiptExtras;
  const channelId = sr.channelId ?? (credential as any)?.channelId;

  if (payload?.action === "open") {
    if (!channelId || !sr.depositAmount) return;

    const depositInCents = Number(BigInt(sr.depositAmount) * 100n / 1_000_000n);

    const pi = await stripeStub.paymentIntents.create(
      {
        amount: depositInCents,
        currency: "usd",
        capture_method: "manual",
        metadata: { channelId, network: "tempo" },
      },
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
    await stripeStub.paymentIntents.incrementAuthorization(entry.piId, { amount: newTotal });
    pendingPaymentIntents.set(channelId, { piId: entry.piId, authorizedCents: newTotal });
    console.log(`Stripe PI incremented: +${additionalCents}¢ → ${newTotal}¢ total for channel ${channelId}`);
    return;
  }

  if (payload?.action === "close") {
    if (!sr.txHash || !sr.acceptedCumulative) return;

    const amountInCents = Number(BigInt(sr.acceptedCumulative) * 100n / 1_000_000n);
    const entry = channelId ? pendingPaymentIntents.get(channelId) : undefined;
    const piId = entry?.piId;

    if (piId) {
      await stripeStub.paymentIntents.capture(
        piId,
        {
          amount_to_capture: amountInCents,
          transaction_verification_options: {
            transaction_hash: sr.txHash,
            network: "tempo",
          },
        },
      );
      if (channelId) pendingPaymentIntents.delete(channelId);
      console.log(`Stripe PI captured: ${amountInCents}¢ for settle tx ${sr.txHash}`);
    } else {
      await stripeStub.paymentIntents.create(
        {
          amount: amountInCents,
          currency: "usd",
          mode: "transaction_verification",
          transaction_verification_options: {
            transaction_hash: sr.txHash,
            network: "tempo",
          },
          confirm: true,
        },
        { idempotencyKey: sr.txHash },
      );
      console.log(`Stripe PI created at close (fallback): ${amountInCents}¢ for settle tx ${sr.txHash}`);
    }
  }
});

const app = express();
app.use(express.json());

// Each GET /photos/:id charges one unit ($0.01) against the open session.
// mppx.session() verifies the voucher in the request and deducts the amount
// before the handler runs — no explicit charge() call needed.
app.get(
  "/photos/:id",
  mppx.session({ amount: PRICE_PER_REQUEST, unitType: "photo" }),
  (req, res) => {
    res.json({
      id: req.params.id,
      url: `https://example.com/photos/${req.params.id}.jpg`,
      caption: `Photo ${req.params.id}`,
    });
  },
);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Pay-as-you-go gateway running on http://localhost:${PORT}`);
  console.log(`Endpoint: GET http://localhost:${PORT}/photos/:id`);
});
