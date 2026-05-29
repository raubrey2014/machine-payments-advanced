import crypto from "crypto";
import express from "express";
import { Mppx, stripe as stripeMpp } from "mppx/express";
import OpenAI from "openai";
import Stripe from "stripe";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-03-04.preview" as Stripe.LatestApiVersion,
});

const NETWORK_ID = process.env.STRIPE_NETWORK_ID!;
const AUTHORIZE_AMOUNT = "500"; // $5.00 max authorization (500 cents)
const PRICE_PER_TOKEN = 0.01; // $0.01 per token in cents

// Track active authorizations
const authorizations = new Map<string, {
  paymentIntentId: string;
  authorizedAmount: number;
  capturedAmount: number;
  currency: string;
}>();

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY ?? crypto.randomBytes(32).toString("base64"),
  methods: [
    // Hypothetical: stripe.authorize() method for mppx.
    // Issues challenges with method="stripe", intent="authorize".
    // The client creates an SPT scoped to the max authorization amount.
    // Server creates a manual-capture PaymentIntent with the SPT.
    stripeMpp.authorize({
      amount: AUTHORIZE_AMOUNT,
      currency: "usd",
      networkId: NETWORK_ID,
      paymentMethodTypes: ["card", "link"],
      authorizationExpires: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      hooks: {
        // Client sends an SPT. Server creates a manual-capture PaymentIntent.
        authorized: async ({ credential, request, challengeId }) => {
          const spt = credential.payload.spt;

          // Create PaymentIntent with manual capture using the SPT
          const pi = await stripe.paymentIntents.create({
            amount: Number(request.amount),
            currency: request.currency,
            capture_method: "manual",
            payment_method_data: {
              type: "card",
              shared_payment_granted_token: spt,
            } as any,
            confirm: true,
            metadata: {
              challenge_id: challengeId,
              mpp_intent: "authorize",
            },
          } as any, {
            idempotencyKey: `${challengeId}_${spt}`,
          });

          if (pi.status !== "requires_capture") {
            throw new Error(`PaymentIntent status is ${pi.status}, expected requires_capture`);
          }

          authorizations.set(challengeId, {
            paymentIntentId: pi.id,
            authorizedAmount: Number(request.amount),
            capturedAmount: 0,
            currency: request.currency,
          });

          console.log(`Authorization active: PI ${pi.id}, $${Number(request.amount) / 100} hold`);

          return {
            authorizationId: pi.id,
            amount: request.amount,
            currency: request.currency,
          };
        },
      },
    }),
  ],
});

const app = express();
app.use(express.json());

// Auth+Capture endpoint: the middleware handles the 402 → SPT → manual-capture PI flow.
// Once authorized, req.authorization provides a capture handle.
app.post(
  "/v1/chat/completions",
  mppx.authorize({
    amount: AUTHORIZE_AMOUNT,
    authorizationExpires: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }),
  async (req, res) => {
    const auth = req.authorization!;

    const upstream = await openai.chat.completions.create({
      ...req.body,
      stream: false,
    } as OpenAI.ChatCompletionCreateParams);

    // Calculate cost based on token usage
    const tokensUsed = upstream.usage?.total_tokens ?? 0;
    const costInCents = Math.ceil(tokensUsed * PRICE_PER_TOKEN);

    // Capture this amount against the PaymentIntent
    const authorization = authorizations.get(auth.challengeId);
    if (authorization) {
      const newCaptured = authorization.capturedAmount + costInCents;

      if (newCaptured > authorization.authorizedAmount) {
        return res.status(402).json({
          error: "authorization_exhausted",
          detail: `Would exceed authorized amount ($${authorization.authorizedAmount / 100})`,
        });
      }

      // Stripe multicapture (if available) or accumulate for final capture
      authorization.capturedAmount = newCaptured;
      console.log(
        `Captured ${costInCents}¢ for ${tokensUsed} tokens. ` +
        `Total: ${newCaptured}¢ / ${authorization.authorizedAmount}¢`,
      );
    }

    res.json(upstream);
  },
);

// Authorization info
app.get("/v1/authorization/info", async (req, res) => {
  const authId = req.headers["x-authorization-id"] as string;
  if (!authId) return res.status(400).json({ error: "x-authorization-id header required" });

  const auth = authorizations.get(authId);
  if (!auth) return res.status(404).json({ error: "authorization not found" });

  const pi = await stripe.paymentIntents.retrieve(auth.paymentIntentId);

  res.json({
    paymentIntentId: auth.paymentIntentId,
    status: pi.status,
    authorizedAmount: auth.authorizedAmount,
    capturedAmount: auth.capturedAmount,
    remainingAmount: auth.authorizedAmount - auth.capturedAmount,
    currency: auth.currency,
  });
});

// Capture: finalize and capture the accumulated amount on the PaymentIntent
app.post("/v1/authorization/capture", async (req, res) => {
  const authId = req.headers["x-authorization-id"] as string;
  if (!authId) return res.status(400).json({ error: "x-authorization-id header required" });

  const auth = authorizations.get(authId);
  if (!auth) return res.status(404).json({ error: "authorization not found" });

  if (auth.capturedAmount === 0) {
    return res.status(400).json({ error: "nothing to capture" });
  }

  // Capture the accumulated amount on Stripe
  const pi = await stripe.paymentIntents.capture(auth.paymentIntentId, {
    amount_to_capture: auth.capturedAmount,
  });

  console.log(`Final capture: ${auth.capturedAmount}¢ on PI ${auth.paymentIntentId}`);
  res.json({
    paymentIntentId: pi.id,
    status: pi.status,
    capturedAmount: auth.capturedAmount,
    releasedAmount: auth.authorizedAmount - auth.capturedAmount,
  });
});

// Void: cancel the PaymentIntent, release the entire hold
app.post("/v1/authorization/void", async (req, res) => {
  const authId = req.headers["x-authorization-id"] as string;
  if (!authId) return res.status(400).json({ error: "x-authorization-id header required" });

  const auth = authorizations.get(authId);
  if (!auth) return res.status(404).json({ error: "authorization not found" });

  await stripe.paymentIntents.cancel(auth.paymentIntentId);

  console.log(`Voided authorization: PI ${auth.paymentIntentId}`);
  res.json({
    paymentIntentId: auth.paymentIntentId,
    status: "voided",
    releasedAmount: auth.authorizedAmount,
  });
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`Auth+Capture Gateway (SPT) running on http://localhost:${PORT}`);
  console.log(`  POST /v1/chat/completions      — generate (captures per-request)`);
  console.log(`  GET  /v1/authorization/info    — check authorization status`);
  console.log(`  POST /v1/authorization/capture — finalize capture on Stripe`);
  console.log(`  POST /v1/authorization/void    — void (cancel PI, release hold)`);
});
