import { expect, test } from "vitest";
import { prisma } from "../lib/prisma";
import {
  cancelReservation,
  expireReservations,
  joinQueue,
  reserve,
} from "../server/services/inventory";
import {
  deliverPayments,
  processPayment,
  simulatePayment,
} from "../server/services/payments";
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
test("duplicate and distinct success IDs buy only one pair; processing cannot regress PAID", async () => {
  const hold = await reserve(user(0), clock);
  const event = {
    id: "success",
    orderId: hold.order!.id,
    type: "payment.succeeded" as const,
  };
  await Promise.all(
    Array.from({ length: 12 }, () => processPayment(event, clock)),
  );
  await processPayment({ ...event, id: "another-success" }, clock);
  await processPayment(
    { ...event, id: "late-processing", type: "payment.processing" },
    clock,
  );
  expect(await prisma.paymentEvent.count()).toBe(3);
  expect((await invariant()).paid).toBe(1);
  expect(
    (await prisma.order.findUniqueOrThrow({ where: { id: hold.order!.id } }))
      .status,
  ).toBe("PAID");
});
test("late success after reassignment requires refund and never changes the new owner's hold", async () => {
  const holds = await exhaust();
  await joinQueue(user(20), clock);
  await expireReservations(afterExpiry);
  const next = await prisma.reservation.findFirstOrThrow({
    where: { userId: user(20), status: "ACTIVE" },
  });
  const event = {
    id: "late-success",
    orderId: holds[0].order!.id,
    type: "payment.succeeded" as const,
  };
  await processPayment(event, afterExpiry);
  await processPayment(
    { ...event, id: "late-processing", type: "payment.processing" },
    afterExpiry,
  );
  await processPayment({ ...event, id: "second-late-success" }, afterExpiry);
  expect(
    (await prisma.order.findUniqueOrThrow({ where: { id: event.orderId } }))
      .status,
  ).toBe("REFUND_REQUIRED");
  expect(
    await prisma.reservation.findUnique({ where: { id: next.id } }),
  ).toEqual(next);
  await invariant();
});
test("cancelled hold is never restored by payment", async () => {
  const hold = await reserve(user(0), clock);
  await cancelReservation(user(0), clock);
  await processPayment(
    { id: "cancelled", orderId: hold.order!.id, type: "payment.succeeded" },
    clock,
  );
  expect((await invariant()).product.availableStock).toBe(20);
  expect(
    (await prisma.order.findUniqueOrThrow({ where: { id: hold.order!.id } }))
      .status,
  ).toBe("REFUND_REQUIRED");
});
test("persisted gateway deliveries survive replay and concurrent workers", async () => {
  const hold = await reserve(user(0), clock);
  await simulatePayment(
    user(0),
    { orderId: hold.order!.id, mode: "out_of_order" },
    clock,
  );
  expect(await prisma.paymentDelivery.count()).toBe(3);
  const later = () => new Date(NOW.getTime() + 20_000);
  await Promise.all([deliverPayments(later), deliverPayments(later)]);
  expect(
    await prisma.paymentDelivery.count({ where: { deliveredAt: null } }),
  ).toBe(0);
  expect((await invariant()).paid).toBe(1);
  // Simulate a crash after processing but before acknowledging delivery.
  await prisma.paymentDelivery.updateMany({ data: { deliveredAt: null } });
  await deliverPayments(later);
  expect(await prisma.paymentEvent.count()).toBe(2);
  expect((await invariant()).paid).toBe(1);
});
test("event ID collisions cannot redirect a previously processed event", async () => {
  const first = await reserve(user(0), clock);
  const second = await reserve(user(1), clock);
  await processPayment(
    { id: "collision", orderId: first.order!.id, type: "payment.succeeded" },
    clock,
  );
  await expect(
    processPayment(
      { id: "collision", orderId: second.order!.id, type: "payment.succeeded" },
      clock,
    ),
  ).rejects.toMatchObject({ code: "EVENT_ID_CONFLICT" });
  await invariant();
});
test("simulated payments enforce ownership and one attempt per order", async () => {
  const hold = await reserve(user(0), clock);
  await expect(
    simulatePayment(
      user(1),
      { orderId: hold.order!.id, mode: "random" },
      clock,
    ),
  ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  await simulatePayment(
    user(0),
    { orderId: hold.order!.id, mode: "late" },
    clock,
  );
  await expect(
    simulatePayment(
      user(0),
      { orderId: hold.order!.id, mode: "random" },
      clock,
    ),
  ).rejects.toMatchObject({ code: "PAYMENT_ALREADY_SCHEDULED" });
  await invariant();
});
