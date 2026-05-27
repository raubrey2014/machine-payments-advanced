import { tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const PRIVATE_KEY = (process.env.CLIENT_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";

const session = tempo.session({
  account: privateKeyToAccount(PRIVATE_KEY),
  maxDeposit: "1", // 1 PathUSD = up to 10,000 tokens at $0.0001/token
});

const body = JSON.stringify({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Write a haiku about blockchain payments." }],
});

console.log("Opening MPP session and streaming chat completion...\n");

// session.sse() manages the full lifecycle: opens channel, streams SSE events,
// handles payment-need-voucher renewals automatically.
const stream = await session.sse(`${SERVER_URL}/v1/chat/completions`, {
  method: "POST",
  body,
  headers: { "Content-Type": "application/json" },
});

for await (const data of stream) {
  const chunk = JSON.parse(data);
  const content = chunk.choices?.[0]?.delta?.content;
  if (content) process.stdout.write(content);
}

console.log("\n\nStream complete. Closing session...");
const receipt = await session.close();
console.log("Session closed. Receipt:", receipt);
