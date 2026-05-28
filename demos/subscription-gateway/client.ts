import { tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const PRIVATE_KEY = (process.env.CLIENT_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const USER_ID = process.env.USER_ID ?? "demo-user";

const session = tempo.subscription({
  account: privateKeyToAccount(PRIVATE_KEY),
  maxDeposit: "2", // enough for two periods
});

// First request: triggers activation (pays period 0 on-chain, server creates Stripe PI).
// Subsequent requests within the same period: served free from the active subscription.
console.log(`Making request as user: ${USER_ID}\n`);

const response = await session.fetch(`${SERVER_URL}/api/pro`, {
  headers: { "x-user-id": USER_ID },
});

if (!response.ok) {
  console.error(`Error ${response.status}:`, await response.text());
  process.exit(1);
}

const data = await response.json();
console.log("Response:", data);
