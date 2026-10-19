import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import request from "supertest";
import { expect, test } from "vitest";
import { app } from "../server/app";
import { databaseTests, user } from "./helpers";

databaseTests();
const server = () => createServer(getRequestListener(app.fetch));
test("HTTP health, demo auth, validation, and full reservation endpoints", async () => {
  const http = server();
  await request(http).get("/api/health").expect(200);
  const unauthorized = await request(http)
    .post("/api/reservations")
    .send({})
    .expect(401);
  expect(unauthorized.body.error.code).toBe("UNAUTHORIZED");
  const invalid = await request(http)
    .post("/api/reservations")
    .set("x-demo-user", user(0))
    .send({ quantity: 100 })
    .expect(400);
  expect(invalid.body.error.code).toBe("INVALID_REQUEST");
  const created = await request(http)
    .post("/api/reservations")
    .set("x-demo-user", user(0))
    .send({})
    .expect(201);
  expect(created.body.reservation.order.status).toBe("PENDING");
  await request(http)
    .get("/api/reservations/me")
    .set("x-demo-user", user(0))
    .expect(200);
  await request(http)
    .get("/api/queue/me")
    .set("x-demo-user", user(0))
    .expect(200);
  await request(http)
    .get("/api/orders/me")
    .set("x-demo-user", user(0))
    .expect(200);
  await request(http)
    .delete("/api/reservations/me")
    .set("x-demo-user", user(0))
    .expect(200);
});
test("webhook validates credentials and body; same event can be retried", async () => {
  const http = server();
  const response = await request(http)
    .post("/api/reservations")
    .set("x-demo-user", user(0))
    .send({})
    .expect(201);
  const body = {
    id: "http-success",
    orderId: response.body.reservation.order.id,
    type: "payment.succeeded",
  };
  await request(http).post("/api/payments/webhook").send(body).expect(401);
  await request(http)
    .post("/api/payments/webhook")
    .set("Authorization", "Bearer test-webhook-secret-only")
    .send({ bad: true })
    .expect(400);
  await request(http)
    .post("/api/payments/webhook")
    .set("Authorization", "Bearer test-webhook-secret-only")
    .send(body)
    .expect(200);
  const duplicate = await request(http)
    .post("/api/payments/webhook")
    .set("Authorization", "Bearer test-webhook-secret-only")
    .send(body)
    .expect(200);
  expect(duplicate.body.duplicate).toBe(true);
  const drop = await request(http).get("/api/drop").expect(200);
  expect(drop.body.sold).toBe(1);
});
