import express from "express";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const PRICE_ID = process.env.STRIPE_PRICE_ID ?? "price_1TcTxzHF6svTseXk1i71yfSz";
const NETWORK_ID = process.env.STRIPE_NETWORK_ID ?? "profile_test_61UaFCQmHNgvCEyLpA6UaFCPFRSQi5bS2896k3DNgPlQ";

// ─── Stubbed mppx-like layer ────────────────────────────────────────────────
// This simulates what `stripeMpp.subscription()` would do in mppx:
// - Issues 402 challenges with method="stripe", intent="subscription"
// - Accepts credentials containing an SPT
// - Calls hooks on activation/renewal
//
// In production this would be:
//   import { Mppx, stripe } from "mppx/express"
//   const mppx = Mppx.create({ methods: [stripe.subscription({ ... })] })
//   app.get("/api/pro", mppx.subscription({}), handler)

type SubscriptionState = {
  customerId: string;
  subscriptionId: string;
  userId: string;
};

const subscriberState = new Map<string, SubscriptionState>();

function mppxSubscriptionMiddleware() {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const userId = req.headers["x-user-id"] as string;
    if (!userId) {
      return res.status(400).json({ error: "x-user-id header required" });
    }

    // Check if user has an active subscription
    const state = subscriberState.get(userId);
    if (state) {
      const sub = await stripe.subscriptions.retrieve(state.subscriptionId);
      if (sub.status === "active" || sub.status === "trialing") {
        // Subscription active — proceed to handler
        return next();
      }
    }

    // Check for incoming credential (SPT in Authorization header)
    const authHeader = req.headers["authorization"];
    if (authHeader?.startsWith("Payment ")) {
      // Decode credential — in real mppx this is base64url JSON
      // For this demo, accept JSON body with spt field on POST /api/subscription/activate
      return res.status(402).json({
        error: "use POST /api/subscription/activate to subscribe",
      });
    }

    // No subscription, no credential — issue a 402 challenge
    // This is what mppx would return as WWW-Authenticate
    const challenge = {
      method: "stripe",
      intent: "subscription",
      amount: "100",
      currency: "usd",
      periodCount: "1",
      periodUnit: "week",
      networkId: NETWORK_ID,
      paymentMethodTypes: ["card", "link"],
    };

    res.status(402).json({
      type: "https://paymentauth.org/problems/payment-required",
      title: "Subscription Required",
      status: 402,
      detail: "This resource requires an active subscription",
      challenge,
    });
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Activate subscription: client sends SPT
// In real mppx, this would happen inside the middleware when the client
// retries with an Authorization: Payment <credential> header.
app.post("/api/subscription/activate", async (req, res) => {
  const { spt, userId } = req.body;

  if (!spt || !userId) {
    return res.status(400).json({ error: "spt and userId required" });
  }

  // ─── This is what mppx hooks.activated() would do ───
  const customer = await stripe.customers.create({
    metadata: { mpp_user_id: userId },
  });

  // Create subscription with SPT directly:
  //   stripe post /v1/subscriptions \
  //     -d customer=cus_xxx \
  //     -d "items[0][price]=price_xxx" \
  //     -d default_shared_payment_token=spt_xxx
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: PRICE_ID }],
    default_shared_payment_token: spt,
    expand: ["latest_invoice.payment_intent"],
  } as any);

  subscriberState.set(userId, {
    customerId: customer.id,
    subscriptionId: subscription.id,
    userId,
  });

  console.log(`Subscription ${subscription.id} created for ${userId} via SPT`);

  res.json({
    subscriptionId: subscription.id,
    customerId: customer.id,
    status: subscription.status,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
  });
});

// Gated content — uses the mppx-like middleware
app.get("/api/pro", mppxSubscriptionMiddleware(), (_req, res) => {
  res.json({
    message: "Welcome to pro content!",
    timestamp: new Date().toISOString(),
  });
});

// Subscription info
app.get("/api/subscription/info", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(400).json({ error: "x-user-id header required" });

  const state = subscriberState.get(userId);
  if (!state) return res.status(404).json({ error: "no subscription found" });

  const sub = await stripe.subscriptions.retrieve(state.subscriptionId);

  res.json({
    subscriptionId: sub.id,
    customerId: state.customerId,
    status: sub.status,
    currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
  });
});

// Cancel subscription
app.post("/api/subscription/cancel", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(400).json({ error: "x-user-id header required" });

  const state = subscriberState.get(userId);
  if (!state) return res.status(404).json({ error: "no subscription found" });

  const sub = await stripe.subscriptions.update(state.subscriptionId, {
    cancel_at_period_end: true,
  });

  console.log(`Subscription ${sub.id} set to cancel at period end`);
  res.json({
    status: "canceling",
    cancelAt: new Date(sub.cancel_at! * 1000).toISOString(),
    currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
  });
});

const PORT = process.env.PORT ?? 3003;
app.listen(PORT, () => {
  console.log(`Subscription gateway (SPT + Stripe Billing) running on http://localhost:${PORT}`);
  console.log();
  console.log(`Endpoints:`);
  console.log(`  POST /api/subscription/activate — send { spt, userId } to start`);
  console.log(`  GET  /api/pro                   — gated content (x-user-id header)`);
  console.log(`  GET  /api/subscription/info     — check status (x-user-id header)`);
  console.log(`  POST /api/subscription/cancel   — cancel at period end (x-user-id header)`);
  console.log();
  console.log(`What mppx would do:`);
  console.log(`  1. GET /api/pro with no sub → 402 with challenge (method=stripe, intent=subscription)`);
  console.log(`  2. Client creates SPT via Stripe/Link and retries with credential`);
  console.log(`  3. Server creates Subscription with default_shared_payment_token=spt_xxx`);
  console.log(`  4. Stripe auto-charges on schedule — client doesn't participate in renewals`);
});
