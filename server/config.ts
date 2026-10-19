import "../lib/env";
import { z } from "zod";

export const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    DEMO_MODE: z.enum(["true", "false"]).default("true"),
    PAYMENT_WEBHOOK_SECRET: z.string().min(16),
    WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  })
  .parse(process.env);
