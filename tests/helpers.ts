import { beforeEach, afterAll, expect } from "vitest";
import { prisma } from "../lib/prisma";
import {
  HOLD_MS,
  PRODUCT_ID,
  holding,
  reserve,
} from "../server/services/inventory";
import { processPayment } from "../server/services/payments";

export const NOW = new Date("2030-01-01T00:00:00.000Z");
export const clock = () => new Date(NOW);
export const afterExpiry = () => new Date(NOW.getTime() + HOLD_MS);
export const user = (n: number) => `user-${n}`;

export function databaseTests() {
  beforeEach(async () => {
    if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))
      throw new Error("Refusing to erase a non-test database");
    await prisma.$executeRawUnsafe(
      'TRUNCATE "PaymentDelivery", "PaymentEvent", "QueueEntry", "Order", "Reservation", "User", "Product" RESTART IDENTITY CASCADE',
    );
    await prisma.product.create({
      data: {
        id: PRODUCT_ID,
        name: "Test Drop",
        totalStock: 20,
        availableStock: 20,
      },
    });
    await prisma.user.createMany({
      data: Array.from({ length: 1050 }, (_, i) => ({
        id: user(i),
        name: `User ${i}`,
        email: `user${i}@test.local`,
        demo: i < 6,
      })),
    });
  });
  afterAll(() => prisma.$disconnect());
}
export async function exhaust() {
  return Promise.all(
    Array.from({ length: 20 }, (_, i) => reserve(user(i), clock)),
  );
}
export async function buy(userId: string, id: string) {
  const hold = await reserve(userId, clock);
  await processPayment(
    { id, orderId: hold.order!.id, type: "payment.succeeded" },
    clock,
  );
  return hold;
}
export async function invariant() {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: PRODUCT_ID },
  });
  const active = await prisma.reservation.count({
    where: { status: { in: [...holding] } },
  });
  const paid = await prisma.order.count({ where: { status: "PAID" } });
  expect(product.availableStock).toBeGreaterThanOrEqual(0);
  expect(product.availableStock + active + paid).toBe(20);
  return { product, active, paid };
}
