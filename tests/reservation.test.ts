import { expect, test } from "vitest";
import { prisma } from "../lib/prisma";
import {
  cancelReservation,
  expireReservations,
  reserve,
} from "../server/services/inventory";
import { processPayment } from "../server/services/payments";
import {
  afterExpiry,
  buy,
  clock,
  databaseTests,
  invariant,
  user,
} from "./helpers";

databaseTests();
test("simultaneous requests by one user create one hold", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 25 }, () => reserve(user(0), clock)),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    await prisma.reservation.count({
      where: { userId: user(0), status: "ACTIVE" },
    }),
  ).toBe(1);
  await invariant();
});
test("two purchases succeed; concurrent attempts for a third all fail", async () => {
  await buy(user(0), "first");
  await buy(user(0), "second");
  const results = await Promise.allSettled(
    Array.from({ length: 15 }, () => reserve(user(0), clock)),
  );
  expect(
    results.every(
      (r) =>
        r.status === "rejected" && r.reason.code === "PURCHASE_LIMIT_REACHED",
    ),
  ).toBe(true);
  expect((await invariant()).paid).toBe(2);
});
test("the partial unique index rejects a second active hold", async () => {
  await reserve(user(0), clock);
  await expect(
    prisma.reservation.create({
      data: {
        userId: user(0),
        productId: "sneaker-drop",
        expiresAt: afterExpiry(),
      },
    }),
  ).rejects.toThrow();
  await invariant();
});
test("repeated and concurrent expiry releases stock once", async () => {
  await reserve(user(0), clock);
  await Promise.all(
    Array.from({ length: 10 }, () => expireReservations(afterExpiry)),
  );
  expect((await invariant()).product.availableStock).toBe(20);
  expect(await prisma.order.count({ where: { status: "EXPIRED" } })).toBe(1);
});
test("expiry racing a success at the deadline never sells an expired pair", async () => {
  const hold = await reserve(user(0), clock);
  await Promise.all([
    expireReservations(afterExpiry),
    processPayment(
      { id: "deadline", orderId: hold.order!.id, type: "payment.succeeded" },
      afterExpiry,
    ),
  ]);
  expect(
    (await prisma.order.findUniqueOrThrow({ where: { id: hold.order!.id } }))
      .status,
  ).toBe("REFUND_REQUIRED");
  expect((await invariant()).product.availableStock).toBe(20);
});
test("a successful payment before expiry remains sold across expiry ticks", async () => {
  await buy(user(0), "on-time");
  await expireReservations(afterExpiry);
  expect((await invariant()).paid).toBe(1);
  expect((await invariant()).product.availableStock).toBe(19);
});
test("cancel and payment racing preserve inventory whichever wins the lock", async () => {
  const hold = await reserve(user(0), clock);
  await Promise.allSettled([
    cancelReservation(user(0), clock),
    processPayment(
      { id: "cancel-race", orderId: hold.order!.id, type: "payment.succeeded" },
      clock,
    ),
  ]);
  await invariant();
});
test("a failed reservation insert rolls back the stock decrement", async () => {
  await expect(reserve("missing-user", clock)).rejects.toThrow();
  expect((await invariant()).product.availableStock).toBe(20);
});
