import crypto from "crypto";
import express from "express";
import { Mppx, tempo } from "mppx/express";
import { Store, Subscription } from "mppx/server";
import Stripe from "stripe";

const stripe = process.env.STRIPE_CONNECTED === "true"
  ? new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-03-04.preview" as Stripe.LatestApiVersion,
    })
  : null;

// $1.00/week subscription
const PLAN_AMOUNT = "1.00";

const store = Store.memory();
const subscriptions = Subscription.fromStore(store);

async function createPeriodPaymentIntent(params: {
  subscriptionId: string;
  reference: string;
  periodIndex: number;
  amountRaw: string;
  payerAddress: string;
}) {
  if (!stripe) return;

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
      store,
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

// Gated content
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

// Subscription info
app.get("/api/subscription/info", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(400).json({ error: "x-user-id header required" });

  const subscription = await subscriptions.getByKey(`user:${userId}`);
  if (!subscription) return res.status(404).json({ error: "no subscription found" });

  res.json({
    subscriptionId: subscription.subscriptionId,
    status: subscription.canceledAt ? "canceled" : "active",
    canceledAt: subscription.canceledAt ?? null,
    amount: subscription.amount,
    periodUnit: subscription.periodUnit,
    periodCount: subscription.periodCount,
    payer: subscription.payer?.address ?? null,
  });
});

// Cancel subscription
app.post("/api/subscription/cancel", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(400).json({ error: "x-user-id header required" });

  const subscription = await subscriptions.getByKey(`user:${userId}`);
  if (!subscription) return res.status(404).json({ error: "no subscription found" });

  if (subscription.canceledAt) {
    return res.json({ status: "already_canceled", canceledAt: subscription.canceledAt });
  }

  // Mark canceled in the mppx store. Next paid request will get a 402.
  await subscriptions.put({
    ...subscription,
    canceledAt: new Date().toISOString(),
  });

  console.log(`Subscription canceled: ${subscription.subscriptionId}`);
  res.json({ status: "canceled", canceledAt: new Date().toISOString() });
});

const PORT = process.env.PORT ?? 3002;
app.listen(PORT, () => {
  console.log(`Subscription gateway running on http://localhost:${PORT}`);
  console.log(`  GET  /api/pro                  — gated content`);
  console.log(`  GET  /api/subscription/info    — subscription status`);
  console.log(`  POST /api/subscription/cancel  — cancel subscription`);
});
