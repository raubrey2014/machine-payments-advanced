import crypto from "crypto";
import express from "express";
import { Mppx, tempo } from "mppx/express";
import { Store, Subscription } from "mppx/server";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-03-04.preview" as Stripe.LatestApiVersion,
});

// $1.00/week subscription
const PLAN_AMOUNT = "1000000"; // 1 PathUSD (6 decimals)
const PRICE_ID = process.env.STRIPE_PRICE_ID!;

const store = Store.memory();
const subscriptions = Subscription.fromStore(store);

// Map payer addresses to Stripe state
const payerState = new Map<string, {
  customerId: string;
  stripeSubscriptionId: string;
  channelId: string;
}>();

// In this model, Stripe is the operator and authorizedSigner on the
// TIP-1034 channel. The payer opens a channel granting Stripe the
// ability to settle each period's amount without further payer interaction.
//
// Stripe then creates a real Subscription with charge_automatically —
// on each billing cycle, Stripe signs a voucher and calls settle() on-chain,
// transferring the period amount to the recipient.

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
      operator: "stripe",
      resolve: async ({ input }) => {
        const userId = input.headers.get("x-user-id");
        return userId ? { key: `user:${userId}` } : null;
      },
      hooks: {
        activated: async ({ receipt, subscription }) => {
          const customer = await stripe.customers.create({
            metadata: {
              tempo_address: subscription.payer?.address ?? "unknown",
              channel_id: receipt.channelId,
            },
          });

          const sub = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: PRICE_ID }],
            collection_method: "charge_automatically",
            metadata: {
              mpp_subscription_id: receipt.subscriptionId,
              channel_id: receipt.channelId,
              settlement_network: "tempo",
              operator_role: "stripe",
            },
            payment_settings: {
              payment_method_types: ["tempo_channel"],
              save_default_payment_method: "on_subscription",
            },
          } as any);

          payerState.set(subscription.payer?.address ?? "unknown", {
            customerId: customer.id,
            stripeSubscriptionId: sub.id,
            channelId: receipt.channelId,
          });

          console.log(
            `Subscription ${sub.id} created with Stripe as operator. ` +
            `Channel ${receipt.channelId} will be auto-settled each period.`,
          );
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

  const state = payerState.get(subscription.payer?.address ?? "");

  // Since Stripe drives billing, pull status from Stripe
  let stripeStatus = null;
  if (state) {
    const stripeSub = await stripe.subscriptions.retrieve(state.stripeSubscriptionId);
    stripeStatus = stripeSub.status;
  }

  res.json({
    subscriptionId: subscription.subscriptionId,
    stripeSubscriptionId: state?.stripeSubscriptionId ?? null,
    channelId: state?.channelId ?? null,
    status: subscription.canceledAt ? "canceled" : stripeStatus ?? "active",
    canceledAt: subscription.canceledAt ?? null,
    amount: subscription.amount,
    periodUnit: subscription.periodUnit,
    periodCount: subscription.periodCount,
    payer: subscription.payer?.address ?? null,
    operator: "stripe",
  });
});

// Cancel subscription — Stripe cancels the subscription and stops settling
app.post("/api/subscription/cancel", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(400).json({ error: "x-user-id header required" });

  const subscription = await subscriptions.getByKey(`user:${userId}`);
  if (!subscription) return res.status(404).json({ error: "no subscription found" });

  if (subscription.canceledAt) {
    return res.json({ status: "already_canceled", canceledAt: subscription.canceledAt });
  }

  // Cancel in mppx store
  await subscriptions.put({
    ...subscription,
    canceledAt: new Date().toISOString(),
  });

  // Cancel the Stripe Subscription — Stripe stops auto-settling on-chain
  const state = payerState.get(subscription.payer?.address ?? "");
  if (state) {
    await stripe.subscriptions.cancel(state.stripeSubscriptionId);
    // Stripe will also void the remaining channel deposit (as operator)
    console.log(`Stripe subscription ${state.stripeSubscriptionId} canceled, channel will be voided`);
  }

  res.json({ status: "canceled", canceledAt: new Date().toISOString() });
});

const PORT = process.env.PORT ?? 3002;
app.listen(PORT, () => {
  console.log(`Subscription gateway (Stripe as Tempo operator) running on http://localhost:${PORT}`);
  console.log(`  GET  /api/pro                  — gated content`);
  console.log(`  GET  /api/subscription/info    — subscription status`);
  console.log(`  POST /api/subscription/cancel  — cancel (Stripe stops settling)`);
});
