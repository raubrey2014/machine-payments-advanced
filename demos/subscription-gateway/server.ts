import crypto from "crypto";
import express from "express";
import { Mppx, tempo } from "mppx/express";
import Stripe from "stripe";

const stripe = process.env.STRIPE_CONNECTED === "true"
  ? new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-03-04.preview" as Stripe.LatestApiVersion,
    })
  : null;

// $1.00/week subscription
const PLAN_AMOUNT = "1.00";

// Called for both activation (period 0) and each renewal.
// Uses the on-chain transfer tx hash as proof, mirroring the session demo's
// mode: "transaction_verification" shape.
async function createPeriodPaymentIntent(params: {
  subscriptionId: string;
  reference: string;
  periodIndex: number;
  amountRaw: string;
  payerAddress: string;
}) {
  if (!stripe) return;

  // amountRaw is PathUSD in 6-decimal raw units; convert to cents.
  const amountInCents = Number(BigInt(params.amountRaw) * 100n / 1_000_000n);

  await stripe.paymentIntents.create(
    {
      amount: amountInCents,
      currency: "usd",
      mode: "transaction_verification",
      transaction_verification_options: {
        transaction_hash: params.reference,
        network: "tempo",
      },
      metadata: {
        subscription_id: params.subscriptionId,
        period_index: String(params.periodIndex),
        payer: params.payerAddress,
      },
      confirm: true,
    } as any,
    { idempotencyKey: params.reference },
  );

  console.log(
    `Stripe PI created: ${amountInCents}¢ for subscription ${params.subscriptionId} ` +
    `period ${params.periodIndex} tx ${params.reference}`,
  );
}

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY ?? crypto.randomBytes(32).toString("base64"),
  methods: [
    tempo.subscription({
      amount: PLAN_AMOUNT,
      currency: "0x20c0000000000000000000000000000000000000", // PathUSD testnet
      periodCount: "1",
      periodUnit: "week",
      recipient: (process.env.RECIPIENT_ADDRESS ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") as `0x${string}`,
      subscriptionExpires: new Date("2027-01-01T00:00:00.000Z"),
      testnet: true,
      resolve: async ({ input }) => {
        const userId = input.headers.get("x-user-id");
        return userId ? { key: `user:${userId}` } : null;
      },
      hooks: {
        activated: async ({ receipt, subscription }) => {
          console.log(`Subscription activated: ${receipt.subscriptionId}`);
          await createPeriodPaymentIntent({
            subscriptionId: receipt.subscriptionId,
            reference: receipt.reference,
            periodIndex: 0,
            amountRaw: subscription.amount,
            payerAddress: subscription.payer?.address ?? "unknown",
          });
        },
        renewed: async ({ periodIndex, receipt, subscription }) => {
          console.log(`Subscription renewed: ${receipt.subscriptionId} period ${periodIndex}`);
          await createPeriodPaymentIntent({
            subscriptionId: receipt.subscriptionId,
            reference: receipt.reference,
            periodIndex,
            amountRaw: subscription.amount,
            payerAddress: subscription.payer?.address ?? "unknown",
          });
        },
      },
    }),
  ],
});

const app = express();
app.use(express.json());

app.get(
  "/api/pro",
  mppx.subscription({}),
  (_req, res) => {
    res.json({
      message: "Welcome to pro content!",
      timestamp: new Date().toISOString(),
    });
  },
);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Subscription gateway running on http://localhost:${PORT}`);
  console.log(`Endpoint: GET http://localhost:${PORT}/api/pro`);
});
