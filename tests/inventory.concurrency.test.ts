import { expect, test } from "vitest";
import { app } from "../server/app";
import { prisma } from "../lib/prisma";
import { databaseTests, invariant, user } from "./helpers";

databaseTests();
test("1,000 simultaneous Hono reservation requests allocate exactly 20 pairs", async () => {
  const responses = await Promise.all(
    Array.from({ length: 1000 }, (_, i) =>
      app.request("/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-demo-user": user(i) },
        body: "{}",
      }),
    ),
  );
  expect(responses.filter((response) => response.status === 201)).toHaveLength(
    20,
  );
  expect(responses.filter((response) => response.status === 409)).toHaveLength(
    980,
  );
  const errors = await Promise.all(
    responses.filter((r) => r.status === 409).map((r) => r.json()),
  );
  expect(errors.every((body) => body.error.code === "OUT_OF_STOCK")).toBe(true);
  const state = await invariant();
  expect(state.active).toBe(20);
  expect(state.product.availableStock).toBe(0);
});
test("PostgreSQL rejects negative inventory even outside the service", async () => {
  await expect(
    prisma.product.update({
      where: { id: "sneaker-drop" },
      data: { availableStock: -1 },
    }),
  ).rejects.toThrow();
  await invariant();
});
