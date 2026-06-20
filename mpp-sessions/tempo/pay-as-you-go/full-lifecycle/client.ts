import { tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const PRIVATE_KEY = (process.env.CLIENT_PRIVATE_KEY) as `0x${string}`;
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";

const session = tempo.session({
  account: privateKeyToAccount(PRIVATE_KEY),
  maxDeposit: "1", // 1 PathUSD = up to 100 photos at $0.01/photo
});

console.log("Opening MPP session...\n");

// session.fetch() works like native fetch but attaches the MPP session voucher.
// The first call opens the on-chain channel; subsequent calls reuse it with
// off-chain vouchers only — no per-request blockchain transactions.
for (const id of ["1", "2", "3"]) {
  const res = await session.fetch(`${SERVER_URL}/photos/${id}`);
  const photo = await res.json();
  console.log(`Photo ${id}:`, photo);
}

console.log("\nClosing session...");
const receipt = await session.close();
console.log("Session closed. Receipt:", receipt);
