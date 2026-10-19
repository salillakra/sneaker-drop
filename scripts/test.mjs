import "dotenv/config";
import { spawnSync } from "node:child_process";

const testUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://sneaker:sneaker@localhost:55433/sneaker_drop_test";
if (!new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error(
    "TEST_DATABASE_URL must name a dedicated database ending in _test; tests erase its data.",
  );
}
const env = {
  ...process.env,
  DATABASE_URL: testUrl,
  DEMO_MODE: "true",
  PAYMENT_WEBHOOK_SECRET: "test-webhook-secret-only",
};
for (const args of [
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  [
    "node_modules/vitest/vitest.mjs",
    ...(process.argv.includes("--watch") ? [] : ["run"]),
  ],
]) {
  const child = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (child.status !== 0) process.exit(child.status ?? 1);
}
