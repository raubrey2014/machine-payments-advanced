import { tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const PRIVATE_KEY = (process.env.CLIENT_PRIVATE_KEY) as `0x${string}`;
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3001";

// tempo.authorize() — client-side authorize flow.
// Unlike tempo.session(), the client only participates once: signing the
// open transaction. After that, the server captures autonomously.
const authorization = tempo.authorize({
  account: privateKeyToAccount(PRIVATE_KEY),
});

console.log("=== MPP Auth + Capture Demo ===\n");

// Step 1: Make a request. The server responds with 402 intent="authorize".
// The client automatically:
//   - Inspects the challenge (amount, currency, recipient, authorizedSigner)
//   - Signs a TIP-1034 open transaction funding the channel
//   - Submits the credential
//   - Gets back 200 — authorization is now active
//
// All subsequent requests reuse the same authorization.
// The client does NOT need to sign vouchers — the server's authorizedSigner does that.

console.log("Making first request (triggers authorization)...\n");

const response1 = await authorization.fetch(`${SERVER_URL}/v1/chat/completions`, {
  method: "POST",
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is authorize and capture in payments? One sentence." }],
  }),
  headers: { "Content-Type": "application/json" },
});

// Stream the response
console.log("Response 1:");
const reader1 = response1.body!.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader1.read();
  if (done) break;
  const text = decoder.decode(value);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice(6));
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) process.stdout.write(content);
  }
}
console.log("\n");

// Step 2: Second request — no new authorization needed.
// The server captures against the existing authorization using its
// authorizedSigner key. The client just makes a normal HTTP request.
console.log("Making second request (reuses existing authorization)...\n");

const response2 = await authorization.fetch(`${SERVER_URL}/v1/chat/completions`, {
  method: "POST",
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is a TIP-1034 channel? One sentence." }],
  }),
  headers: { "Content-Type": "application/json" },
});

console.log("Response 2:");
const reader2 = response2.body!.getReader();
while (true) {
  const { done, value } = await reader2.read();
  if (done) break;
  const text = decoder.decode(value);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice(6));
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) process.stdout.write(content);
  }
}
console.log("\n");

// Step 3: Check authorization status
const status = await authorization.status();
console.log("Authorization status:", {
  id: status.authorizationId,
  authorized: status.amount,
  captured: status.capturedAmount,
  remaining: status.remainingAmount,
});

// Step 4: The client can request early void (payer-initiated reclaim).
// This calls TIP-1034 requestClose() — after the grace period,
// uncaptured funds return to the payer.
//
// Alternatively, the client can just walk away and let the server
// void/close when authorizationExpires is reached.
console.log("\nRequesting void (releasing remaining authorization)...");
await authorization.requestClose();
console.log("Done. Uncaptured funds will return after the close grace period.");
