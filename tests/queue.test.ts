import { expect, test } from "vitest";
import { prisma } from "../lib/prisma";
import {
  cancelReservation,
  expireReservations,
  HOLD_MS,
  joinQueue,
  reserve,
} from "../server/services/inventory";
import {
  afterExpiry,
  clock,
  databaseTests,
  exhaust,
  invariant,
  NOW,
  user,
} from "./helpers";

databaseTests();
test("expiry allocates FIFO with a fresh five-minute hold; duplicate workers are safe", async () => {
  const holds = await exhaust();
  await joinQueue(user(20), clock);
  await joinQueue(user(21), clock);
  // Only one hold expires at this deadline.
  await prisma.reservation.updateMany({
    where: { id: { not: holds[0].id } },
    data: { expiresAt: new Date(NOW.getTime() + 2 * HOLD_MS) },
  });
  await Promise.all([
    expireReservations(afterExpiry),
    expireReservations(afterExpiry),
  ]);
  const allocated = await prisma.reservation.findFirstOrThrow({
    where: { userId: user(20), status: "ACTIVE" },
  });
  expect(allocated.expiresAt.getTime()).toBe(NOW.getTime() + 2 * HOLD_MS);
  expect(await prisma.reservation.count({ where: { userId: user(21) } })).toBe(
    0,
  );
  await invariant();
});
test("new reservations cannot bypass waiting users after worker downtime", async () => {
  await exhaust();
  await joinQueue(user(20), clock);
  await reserve(user(22), afterExpiry);
  const first = await prisma.reservation.findFirst({
    where: { userId: user(20), status: "ACTIVE" },
  });
  expect(first).not.toBeNull();
  await invariant();
});
test("ineligible queued users are skipped; cancellation allocates atomically", async () => {
  const holds = await exhaust();
  await joinQueue(user(20), clock);
  await joinQueue(user(21), clock);
  // Simulates an old queue entry belonging to a user who now holds a pair.
  await prisma.queueEntry.updateMany({
    where: { userId: user(20) },
    data: { userId: user(1) },
  });
  await cancelReservation(holds[0].userId, clock);
  expect(
    await prisma.queueEntry.count({
      where: { userId: user(1), status: "CANCELLED" },
    }),
  ).toBe(1);
  expect(
    await prisma.reservation.count({
      where: { userId: user(21), status: "ACTIVE" },
    }),
  ).toBe(1);
  expect((await invariant()).product.availableStock).toBe(0);
});
test("concurrent queue joins produce one stable FIFO entry", async () => {
  await exhaust();
  const entries = await Promise.all(
    Array.from({ length: 12 }, () => joinQueue(user(20), clock)),
  );
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(1);
  await invariant();
});
test("one released pair goes to the queue before a newcomer even without a worker tick", async () => {
  const holds = await exhaust();
  await joinQueue(user(20), clock);
  await prisma.reservation.updateMany({
    where: { id: { not: holds[0].id } },
    data: { expiresAt: new Date(NOW.getTime() + 2 * HOLD_MS) },
  });
  await expect(reserve(user(22), afterExpiry)).rejects.toMatchObject({
    code: "OUT_OF_STOCK",
  });
  // A failed action rolls back its cleanup too; the worker commits the allocation.
  await expireReservations(afterExpiry);
  expect(
    await prisma.reservation.count({
      where: { userId: user(20), status: "ACTIVE" },
    }),
  ).toBe(1);
  expect(await prisma.reservation.count({ where: { userId: user(22) } })).toBe(
    0,
  );
  await invariant();
});
