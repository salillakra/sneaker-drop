import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ZodError, z } from "zod";
import { Prisma } from "../app/generated/prisma/client";
import { prisma } from "../lib/prisma";
import { config } from "./config";
import { AppError } from "./errors";
import {
  PRODUCT_ID,
  cancelReservation,
  holding,
  joinQueue,
  reserve,
} from "./services/inventory";
import {
  paymentEventSchema,
  processPayment,
  simulatePayment,
  simulationSchema,
} from "./services/payments";

type Env = { Variables: { userId: string } };
export const app = new Hono<Env>().basePath("/api");
app.onError((error, c) => {
  if (error instanceof AppError)
    return c.json(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return c.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid request body or parameters.",
        },
      },
      400,
    );
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return c.json(
      {
        error: {
          code: "STATE_CONFLICT",
          message:
            "This action has already been performed. Refresh and try again.",
        },
      },
      409,
    );
  }
  console.error(error);
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to complete the request. Please try again.",
      },
    },
    500,
  );
});
app.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } }, 404),
);

app.get("/health", async (c) => {
  await prisma.$queryRaw`SELECT 1`;
  return c.json({ status: "ok" });
});
app.get("/drop", async (c) => {
  const data = await prisma.$transaction(
    async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: PRODUCT_ID },
      });
      if (!product)
        throw new AppError("DROP_NOT_FOUND", "Seed the drop first.", 503);
      const held = await tx.reservation.count({
        where: { productId: PRODUCT_ID, status: { in: [...holding] } },
      });
      const sold = await tx.order.count({
        where: { productId: PRODUCT_ID, status: "PAID" },
      });
      const waiting = await tx.queueEntry.count({
        where: { productId: PRODUCT_ID, status: "WAITING" },
      });
      const users =
        config.DEMO_MODE === "true"
          ? await tx.user.findMany({
              where: { demo: true },
              select: { id: true, name: true },
              orderBy: { name: "asc" },
            })
          : [];
      return {
        product,
        held,
        sold,
        waiting,
        users,
        serverTime: new Date().toISOString(),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
  c.header("Cache-Control", "no-store");
  return c.json(data);
});
app.get("/events", (c) => {
  c.header("X-Accel-Buffering", "no");
  c.header("Cache-Control", "no-cache, no-transform");
  return streamSSE(c, async (stream) => {
    // Invalidation-only heartbeat works across Next.js and worker processes.
    // No in-memory event bus or private user data is shared here.
    while (!stream.aborted) {
      await stream.writeSSE({ event: "refresh", data: "{}" });
      await stream.sleep(2000);
    }
  });
});
app.post("/payments/webhook", async (c) => {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (
    !timingSafeEqual(
      digest(c.req.header("authorization") ?? ""),
      digest(`Bearer ${config.PAYMENT_WEBHOOK_SECRET}`),
    )
  ) {
    throw new AppError("UNAUTHORIZED", "Invalid webhook credentials.", 401);
  }
  const result = await processPayment(
    paymentEventSchema.parse(await c.req.json()),
  );
  return c.json({ received: true, ...result });
});

// Development-only impersonation. This is intentionally NOT production auth.
app.use("*", async (c, next) => {
  if (config.DEMO_MODE !== "true")
    throw new AppError(
      "DEMO_DISABLED",
      "Demo authentication is disabled.",
      403,
    );
  const id = c.req.header("x-demo-user");
  if (!id || !(await prisma.user.findUnique({ where: { id } }))) {
    throw new AppError("UNAUTHORIZED", "Select a demo user.", 401);
  }
  c.set("userId", id);
  await next();
});
app.post("/reservations", async (c) => {
  z.object({})
    .strict()
    .parse(await c.req.json());
  return c.json({ reservation: await reserve(c.get("userId")) }, 201);
});
app.get("/reservations/me", async (c) => {
  const reservation = await prisma.reservation.findFirst({
    where: { userId: c.get("userId"), status: { in: [...holding] } },
    include: { order: true },
  });
  return c.json({ reservation, serverTime: new Date().toISOString() });
});
app.delete("/reservations/me", async (c) => {
  await cancelReservation(c.get("userId"));
  return c.json({ cancelled: true });
});
app.post("/queue", async (c) => {
  z.object({})
    .strict()
    .parse(await c.req.json());
  return c.json({ entry: await joinQueue(c.get("userId")) }, 201);
});
app.get("/queue/me", async (c) => {
  const result = await prisma.$transaction(
    async (tx) => {
      const entry = await tx.queueEntry.findFirst({
        where: { userId: c.get("userId"), status: "WAITING" },
      });
      if (!entry) return { entry: null, position: null };
      const ahead = await tx.queueEntry.count({
        where: {
          productId: PRODUCT_ID,
          status: "WAITING",
          position: { lt: entry.position },
        },
      });
      return {
        entry: { ...entry, position: entry.position.toString() },
        position: ahead + 1,
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
  return c.json(result);
});

app.post("/payments/simulate", async (c) => {
  const result = await simulatePayment(
    c.get("userId"),
    simulationSchema.parse(await c.req.json()),
  );
  return c.json(result, 202);
});

app.get("/orders/me", async (c) => {
  const orders = await prisma.order.findMany({
    where: { userId: c.get("userId") },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return c.json({ orders });
});
