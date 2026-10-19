import { prisma } from "../../lib/prisma";
import type { Prisma } from "../../app/generated/prisma/client";
import { AppError } from "../errors";

export const PRODUCT_ID = "sneaker-drop";
export const HOLD_MS = 5 * 60 * 1000;
export const holding = ["ACTIVE", "PAYMENT_PENDING"] as const;
export type Tx = Prisma.TransactionClient;
export type Clock = () => Date;

// All state-changing paths acquire this same lock before reading eligibility.
// Time is read AFTER the lock: time spent waiting must count toward expiry.
export async function locked<T>(
  work: (tx: Tx, now: Date) => Promise<T>,
  clock?: Clock,
) {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Product" WHERE id = ${PRODUCT_ID} FOR UPDATE`;
      if (!rows.length)
        throw new AppError("DROP_NOT_FOUND", "Seed the drop first.", 503);
      const now = clock
        ? clock()
        : (
            await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
          )[0].now;
      return work(tx, now);
    },
    { maxWait: 120_000, timeout: 30_000 },
  );
}

export async function eligibility(tx: Tx, userId: string) {
  const active = await tx.reservation.findFirst({
    where: { userId, status: { in: [...holding] } },
  });
  if (active) return "ACTIVE_RESERVATION_EXISTS";
  const paid = await tx.order.aggregate({
    where: { userId, status: "PAID" },
    _sum: { quantity: true },
  });
  if ((paid._sum.quantity ?? 0) >= 2) return "PURCHASE_LIMIT_REACHED";
  return null;
}

export async function requireEligible(tx: Tx, userId: string) {
  const code = await eligibility(tx, userId);
  if (code)
    throw new AppError(
      code,
      code === "PURCHASE_LIMIT_REACHED"
        ? "You have reached the two-pair purchase limit."
        : "You already have an active reservation.",
    );
}

async function createHold(tx: Tx, userId: string, now: Date) {
  return tx.reservation.create({
    data: {
      userId,
      productId: PRODUCT_ID,
      quantity: 1,
      expiresAt: new Date(now.getTime() + HOLD_MS),
      order: { create: { userId, productId: PRODUCT_ID, quantity: 1 } },
    },
    include: { order: true },
  });
}

// Stock is only temporarily incremented inside the locked transaction; nobody
// can reserve it before FIFO allocation commits in that same transaction.
export async function allocateQueue(tx: Tx, now: Date) {
  let product = await tx.product.findUniqueOrThrow({
    where: { id: PRODUCT_ID },
  });
  while (product.availableStock > 0) {
    const next = await tx.queueEntry.findFirst({
      where: { productId: PRODUCT_ID, status: "WAITING" },
      orderBy: { position: "asc" },
    });
    if (!next) break;
    if (await eligibility(tx, next.userId)) {
      await tx.queueEntry.update({
        where: { id: next.id },
        data: { status: "CANCELLED" },
      });
      continue;
    }
    await createHold(tx, next.userId, now);
    await tx.queueEntry.update({
      where: { id: next.id },
      data: { status: "ALLOCATED" },
    });
    product = await tx.product.update({
      where: { id: PRODUCT_ID },
      data: { availableStock: { decrement: 1 } },
    });
  }
}

export async function expireAndAllocate(tx: Tx, now: Date) {
  const expired = await tx.reservation.findMany({
    where: {
      productId: PRODUCT_ID,
      status: { in: [...holding] },
      expiresAt: { lte: now },
    },
  });
  for (const reservation of expired) {
    await tx.reservation.update({
      where: { id: reservation.id },
      data: { status: "EXPIRED" },
    });
    await tx.order.update({
      where: { reservationId: reservation.id },
      data: { status: "EXPIRED" },
    });
    await tx.queueEntry.updateMany({
      where: { userId: reservation.userId, status: "ALLOCATED" },
      data: { status: "COMPLETED" },
    });
  }
  if (expired.length) {
    await tx.product.update({
      where: { id: PRODUCT_ID },
      data: { availableStock: { increment: expired.length } },
    });
  }
  await allocateQueue(tx, now);
  return expired.length;
}

export function expireReservations(clock?: Clock) {
  return locked((tx, now) => expireAndAllocate(tx, now), clock);
}

export function reserve(userId: string, clock?: Clock) {
  return locked(async (tx, now) => {
    await expireAndAllocate(tx, now);
    await requireEligible(tx, userId);
    const product = await tx.product.findUniqueOrThrow({
      where: { id: PRODUCT_ID },
    });
    if (product.availableStock === 0)
      throw new AppError(
        "OUT_OF_STOCK",
        "All pairs are held or sold. Join the waiting queue.",
      );
    await tx.product.update({
      where: { id: PRODUCT_ID },
      data: { availableStock: { decrement: 1 } },
    });
    return createHold(tx, userId, now);
  }, clock);
}

export function cancelReservation(userId: string, clock?: Clock) {
  return locked(async (tx, now) => {
    await expireAndAllocate(tx, now);
    const reservation = await tx.reservation.findFirst({
      where: { userId, status: { in: [...holding] } },
    });
    if (!reservation)
      throw new AppError(
        "RESERVATION_EXPIRED",
        "There is no active reservation to cancel.",
      );
    await tx.reservation.update({
      where: { id: reservation.id },
      data: { status: "CANCELLED" },
    });
    await tx.order.update({
      where: { reservationId: reservation.id },
      data: { status: "CANCELLED" },
    });
    await tx.queueEntry.updateMany({
      where: { userId, status: "ALLOCATED" },
      data: { status: "COMPLETED" },
    });
    await tx.product.update({
      where: { id: PRODUCT_ID },
      data: { availableStock: { increment: 1 } },
    });
    await allocateQueue(tx, now);
  }, clock);
}

export function joinQueue(userId: string, clock?: Clock) {
  return locked(async (tx, now) => {
    await expireAndAllocate(tx, now);
    await requireEligible(tx, userId);
    const existing = await tx.queueEntry.findFirst({
      where: { userId, status: "WAITING" },
    });
    if (existing)
      return { ...existing, position: existing.position.toString() };
    const product = await tx.product.findUniqueOrThrow({
      where: { id: PRODUCT_ID },
    });
    if (product.availableStock > 0)
      throw new AppError(
        "STOCK_AVAILABLE",
        "A pair is available. Reserve it directly.",
      );
    const entry = await tx.queueEntry.create({
      data: { userId, productId: PRODUCT_ID },
    });
    return { ...entry, position: entry.position.toString() };
  }, clock);
}
