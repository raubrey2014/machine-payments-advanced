import crypto from "crypto";
import express from "express";
import { Mppx, tempo } from "mppx/express";
import { Store, Subscription } from "mppx/server";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-03-04.preview" as Stripe.LatestApiVersion,
});

// $1.00/week subscription
const PLAN_AMOUNT = "1.00";
const PRICE_ID = process.env.STRIPE_PRICE_ID!;

const store = Store.memory();
const subscriptions = Subscription.fromStore(store);

// Map payer addresses to Stripe customer + subscription state.
const payerState = new Map<string, {
  customerId: string;
  stripeSubscriptionId: string;
}>();

async function getOrCreateCustomer(payerAddress: string): Promise<string> {
  const existing = payerState.get(payerAddress);
  if (existing) return existing.customerId;

  const customer = await stripe.customers.create({
    metadata: { tempo_address: payerAddress },
    description: `MPP subscriber ${payerAddress}`,
  });

  return customer.id;
}

async function activateSubscription(params: {
  subscriptionId: string;
  reference: string;
  amountRaw: string;
  payerAddress: string;
}) {
  const customerId = await getOrCreateCustomer(params.payerAddress);

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: PRICE_ID }],
    collection_method: "send_invoice",
    days_until_due: 0,
    metadata: {
      mpp_subscription_id: params.subscriptionId,
      tempo_address: params.payerAddress,
    },
  });

  const invoices = await stripe.invoices.list({
    subscription: subscription.id,
    limit: 1,
  });

  if (invoices.data[0]) {
    await payInvoiceWithTxVerification(invoices.data[0].id, params.reference, params.amountRaw);
  }

  payerState.set(params.payerAddress, {
    customerId,
    stripeSubscriptionId: subscription.id,
  });

  console.log(`Stripe Subscription created: ${subscription.id} for ${params.payerAddress}`);
}

async function renewSubscription(params: {
  subscriptionId: string;
  reference: string;
  periodIndex: number;
  amountRaw: string;
  payerAddress: string;
}) {
  const state = payerState.get(params.payerAddress);
  if (!state) return;

  const invoices = await stripe.invoices.list({
    subscription: state.stripeSubscriptionId,
    status: "open",
    limit: 1,
  });

  if (invoices.data[0]) {
    await payInvoiceWithTxVerification(invoices.data[0].id, params.reference, params.amountRaw);
  }

  console.log(`Subscription renewed: ${state.stripeSubscriptionId} period ${params.periodIndex}`);
}

async function payInvoiceWithTxVerification(
  invoiceId: string,
  txHash: string,
  amountRaw: string,
) {
  const amountInCents = Number(BigInt(amountRaw) * 100n / 1_000_000n);

  await stripe.paymentIntents.create(
    {
      amount: amountInCents,
      currency: "usd",
      mode: "transaction_verification",
      transaction_verification_options: {
        transaction_hash: txHash,
        network: "tempo",
      },
      confirm: true,
    } as any,
    { idempotencyKey: txHash },
  );

  await stripe.invoices.pay(invoiceId, {
    paid_out_of_band: true,
  } as any);

  console.log(`Invoice ${invoiceId} marked paid via tx ${txHash}`);
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
          await activateSubscription({
            subscriptionId: receipt.subscriptionId,
            reference: receipt.reference,
            amountRaw: subscription.amount,
            payerAddress: subscription.payer?.address ?? "unknown",
          });
        },
        renewed: async ({ periodIndex, receipt, subscription }) => {
          await renewSubscription({
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

  const state = payerState.get(subscription.payer?.address ?? "");

  res.json({
    subscriptionId: subscription.subscriptionId,
    stripeSubscriptionId: state?.stripeSubscriptionId ?? null,
    status: subscription.canceledAt ? "canceled" : "active",
    canceledAt: subscription.canceledAt ?? null,
    amount: subscription.amount,
    periodUnit: subscription.periodUnit,
    periodCount: subscription.periodCount,
    payer: subscription.payer?.address ?? null,
  });
});

// Cancel subscription — cancel in both mppx store and Stripe
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

  // Cancel the Stripe Subscription
  const state = payerState.get(subscription.payer?.address ?? "");
  if (state) {
    await stripe.subscriptions.cancel(state.stripeSubscriptionId);
    console.log(`Stripe subscription ${state.stripeSubscriptionId} canceled`);
  }

  console.log(`Subscription canceled: ${subscription.subscriptionId}`);
  res.json({ status: "canceled", canceledAt: new Date().toISOString() });
});

const PORT = process.env.PORT ?? 3002;
app.listen(PORT, () => {
  console.log(`Subscription gateway (Stripe Billing, driven by Tempo) running on http://localhost:${PORT}`);
  console.log(`  GET  /api/pro                  — gated content`);
  console.log(`  GET  /api/subscription/info    — subscription status`);
  console.log(`  POST /api/subscription/cancel  — cancel subscription`);
});
