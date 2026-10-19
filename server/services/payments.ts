import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { AppError } from "../errors";
import { expireAndAllocate, holding, locked, type Clock } from "./inventory";

export const paymentEventSchema = z
  .object({
    id: z.string().min(1).max(200),
    orderId: z.string().min(1).max(200),
    type: z.enum(["payment.processing", "payment.succeeded"]),
  })
  .strict();

export type IncomingPayment = z.infer<typeof paymentEventSchema>;

export const simulationSchema = z
  .object({
    orderId: z.string().min(1),
    mode: z.enum(["random", "out_of_order", "late"]).default("random"),
  })
  .strict();

export function processPayment(input: IncomingPayment, clock?: Clock) {
  const event = paymentEventSchema.parse(input);
  return locked(async (tx, now) => {
    const previous = await tx.paymentEvent.findUnique({
      where: { providerEventId: event.id },
    });
    if (previous) {
      if (previous.orderId !== event.orderId || previous.type !== event.type) {
        throw new AppError(
          "EVENT_ID_CONFLICT",
          "An event ID cannot identify two different events.",
        );
      }
      return { duplicate: true, status: previous.status };
    }
    const order = await tx.order.findUnique({
      where: { id: event.orderId },
      include: { reservation: true },
    });
    if (!order) throw new AppError("ORDER_NOT_FOUND", "Order not found.", 404);
    await expireAndAllocate(tx, now);
    let status: "PROCESSED" | "IGNORED" = "IGNORED";
    // Evaluate the deadline after acquiring the inventory lock. Provider time
    // never resurrects a hold whose stock may already belong to somebody else.
    const eligible =
      holding.some((s) => s === order.reservation.status) &&
      order.reservation.expiresAt.getTime() > now.getTime();
    if (
      event.type === "payment.succeeded" &&
      order.status !== "PAID" &&
      order.status !== "REFUND_REQUIRED"
    ) {
      if (eligible) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "PAID", paidAt: now },
        });
        await tx.reservation.update({
          where: { id: order.reservationId },
          data: { status: "CONVERTED" },
        });
        await tx.queueEntry.updateMany({
          where: { userId: order.userId, status: "ALLOCATED" },
          data: { status: "COMPLETED" },
        });
      } else {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "REFUND_REQUIRED" },
        });
      }
      status = "PROCESSED";
    } else if (
      event.type === "payment.processing" &&
      order.status === "PENDING" &&
      eligible
    ) {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "PROCESSING" },
      });
      status = "PROCESSED";
    }
    await tx.paymentEvent.create({
      data: {
        providerEventId: event.id,
        orderId: event.orderId,
        type: event.type,
        payload: event,
        status,
        processedAt: now,
      },
    });
    return { duplicate: false, status };
  }, clock);
}

export function simulatePayment(
  userId: string,
  input: z.infer<typeof simulationSchema>,
  clock?: Clock,
) {
  return locked(async (tx, now) => {
    const order = await tx.order.findFirst({
      where: { id: input.orderId, userId },
      include: { reservation: true },
    });
    if (!order) throw new AppError("ORDER_NOT_FOUND", "Order not found.", 404);
    if (
      !holding.some((s) => s === order.reservation.status) ||
      order.reservation.expiresAt <= now
    ) {
      throw new AppError(
        "RESERVATION_EXPIRED",
        "This reservation is no longer eligible for payment.",
      );
    }
    const existing = await tx.paymentDelivery.findFirst({
      where: { event: { path: ["orderId"], equals: order.id } },
    });
    if (existing)
      throw new AppError(
        "PAYMENT_ALREADY_SCHEDULED",
        "A simulated payment is already scheduled.",
      );
    const attemptId = randomUUID();
    const processing: IncomingPayment = {
      id: `${attemptId}:processing`,
      orderId: order.id,
      type: "payment.processing",
    };
    const success: IncomingPayment = {
      id: `${attemptId}:success`,
      orderId: order.id,
      type: "payment.succeeded",
    };
    const randomDelay = () => 500 + Math.floor(Math.random() * 4500);
    const processingDelay =
      input.mode === "out_of_order" ? 4000 : randomDelay();
    const late =
      input.mode === "late" ||
      (input.mode === "random" && Math.random() < 0.15);
    const successDelay = late
      ? order.reservation.expiresAt.getTime() - now.getTime() + 2000
      : input.mode === "out_of_order"
        ? 500
        : randomDelay();
    const deliveries = [
      { event: processing, dueAt: new Date(now.getTime() + processingDelay) },
      { event: success, dueAt: new Date(now.getTime() + successDelay) },
    ];
    if (input.mode !== "random" || Math.random() < 0.5) {
      deliveries.push({
        event: success,
        dueAt: new Date(now.getTime() + successDelay + randomDelay()),
      });
    }
    await tx.paymentDelivery.createMany({ data: deliveries });
    return {
      attemptId,
      deliveries: deliveries.map((d) => ({
        type: d.event.type,
        dueAt: d.dueAt,
      })),
    };
  }, clock);
}

export async function deliverPayments(clock?: Clock) {
  const now = clock ? clock() : new Date();
  const due = await prisma.paymentDelivery.findMany({
    where: { deliveredAt: null, dueAt: { lte: now } },
    orderBy: { dueAt: "asc" },
    take: 100,
  });
  for (const delivery of due) {
    try {
      await processPayment(paymentEventSchema.parse(delivery.event), clock);
      // A crash before acknowledgement replays the same provider event ID.
      await prisma.paymentDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveredAt: clock ? clock() : new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });

      console.log("Payment delivery succeeded", delivery.id);
    } catch (error) {
      console.error("Payment delivery failed", delivery.id, error);
      await prisma.paymentDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts: { increment: 1 },
          lastError: "Delivery failed; retry scheduled",
          dueAt: new Date(
            now.getTime() +
              Math.min(60_000, 1000 * 2 ** Math.min(delivery.attempts, 6)),
          ),
        },
      });
    }
  }
  return due.length;
}
