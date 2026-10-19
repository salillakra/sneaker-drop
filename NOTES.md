# Sneaker Drop

Sneaker Drop sells one limited edition of 20 pairs. A reservation holds one pair for five minutes. Each user can hold one pair at a time and buy at most two. Expired and cancelled holds pass to the first eligible waiting user, or return to available stock. Payments are fake, but the inventory and delivery records are real PostgreSQL data.

## Architecture

The existing Next.js, Hono, Prisma and pnpm setup is retained. There is no Express server, Vite app, npm-workspace migration, Redis, or message broker. The React frontend and every HTTP endpoint run in Next.js. This follows the requested Hono-in-Next.js architecture and avoids maintaining two web servers.

- `app/page.tsx`: storefront, demo-user switching, countdown, payment controls, queue status, and order history. TanStack Query owns API state.
- `app/api/[[...route]]/route.ts`: exposes the Hono application through Next.js.
- `server/app.ts`: HTTP validation, demo authentication, consistent errors and SSE.
- `server/services/inventory.ts`: reservation, cancellation, eligibility, expiry and FIFO allocation transactions.
- `server/services/payments.ts`: validated webhook processing and the durable fake gateway.
- `server/workers/run.ts`: a standalone process that polls expiry and pending payment deliveries. It has no HTTP listener. Run it alongside Next.js.
- `lib/prisma.ts`, `lib/env.ts`: shared Prisma client and environment loading for Next.js, the CLI and workers.
- `prisma/`: schema, versioned SQL migrations, and a repeatable seed.
- `tests/`: real PostgreSQL tests using Vitest, Hono requests and Supertest's HTTP transport.

## Schema and database constraints

`Product.availableStock` means unallocated stock; an active reservation means held stock; a `PAID` order means a completed purchase. The invariant is:

```
availableStock + active reservation quantities + PAID order quantities = 20
```

`Reservation` belongs to a user and product. `Order` has a unique reservation relation, so there cannot be two orders for one hold. Cancelled, expired and refund-required orders consume no inventory. Every hold and order has quantity one.

`QueueEntry.position` uses a PostgreSQL sequence, independently of creation timestamps. Gaps are harmless. Queue entries retain their allocation or cancellation history. `PaymentEvent.providerEventId` is unique and an event belongs to an order. `PaymentDelivery` persists each fake gateway delivery, including intentional duplicate deliveries, its due time, attempts, acknowledgement and retry information.

The second SQL migration adds constraints Prisma cannot express: nonnegative stock bounded by exactly 20 total pairs, one-pair quantities, one active/payment-pending reservation per user, and one waiting queue entry per user. Purchase limits and cross-table stock conservation are enforced by the locked service transactions. Direct administrative database writes must respect those rules; they do not have a cross-table database trigger as a safety net.

## Why concurrent requests cannot oversell

Every mutation first locks the single product row using `SELECT ... FOR UPDATE`. All eligibility reads, expiry decisions, queue allocation, stock updates, reservation/order creation, payment changes and event deduplication happen after that lock in the same transaction. Lock acquisition order is always product first, then dependent records. This serializes competing mutations across web processes and worker instances, including two requests from the same user.

The service uses PostgreSQL's default Read Committed isolation. After acquiring the row lock, subsequent reads see the previous holder's committed changes. A request cannot check the old stock while another request decrements it. The stock decrement and hold/order insert commit together, or roll back together. The partial unique index provides an additional active-hold safeguard.

Time comes from PostgreSQL `clock_timestamp()` after acquiring the lock, rather than the transaction start time. Requests waiting for a lock cannot use an old timestamp to buy an expired hold. Tests can supply an explicit clock. Transactions have bounded acquisition and execution times; unexpected failures return a generic error rather than leaking SQL details.

This deliberately coarse lock suits a single 20-pair drop. It favors a small, auditable state machine over maximum write throughput. Supporting many products would require a documented product/user lock order and a per-user lock for a global purchase limit; do not simply add products to this code.

## Expiry and FIFO

A worker tick finds active holds whose deadline has passed while holding the product lock. It expires their orders and releases their quantities. In the same transaction, `allocateQueue` consumes those quantities in ascending queue sequence order, skipping users with an active hold or two paid pairs. Every allocation creates a genuine reservation and pending order with a new five-minute deadline.

The available-stock counter can temporarily increase inside this transaction. Other transactions cannot use that stock before FIFO allocation commits. Release and allocation are never separate commits.

Reservation, queue-join and cancellation requests also perform expiry/FIFO reconciliation. New users therefore cannot bypass waiting users when a worker has fallen behind. A request that fails rolls back its reconciliation too; the worker or a subsequent successful transaction commits cleanup. A delayed worker can delay release, but cannot permit an expired payment or oversell stock.

Two workers can scan the same records. The product lock and status recheck ensure only the first expires an active hold. Later ticks cannot release it again. SIGINT/SIGTERM stops a worker after current work finishes. A crash either rolls back the current transaction or leaves a committed, consistent allocation for the next process.

## Payment semantics

The simulation endpoint accepts one attempt per order and verifies ownership and hold eligibility. It persists deliveries before returning `202`; no in-memory timeout is responsible for delivery durability.

- `random`: delivery delays vary, success and processing can arrive out of order, roughly half the attempts duplicate success, and roughly 15% delay success beyond the reservation deadline.
- `out_of_order`: success is due before processing and success is duplicated.
- `late`: success is due two seconds after the original deadline and is duplicated.

Workers poll persisted due deliveries and pass them through the same transaction service as the authenticated HTTP webhook. This demo does not make loopback HTTP calls to itself. The webhook is separately exercised by HTTP tests. Failed deliveries retry with capped exponential backoff and persist their attempt/error state.

Receipt is committed atomically with event processing. An identical provider ID is acknowledged as a duplicate; reusing an ID for a different order or type returns `EVENT_ID_CONFLICT`. Distinct success events for a paid order are also ignored, so event-ID uniqueness alone is not the purchase safeguard. `payment.processing` can only move an eligible `PENDING` order to `PROCESSING`. It cannot overwrite `PAID`, `EXPIRED`, `CANCELLED`, or `REFUND_REQUIRED`.

A success is eligible only if the reservation is still active and processing occurs strictly before its deadline. Provider timestamps are not trusted to resurrect holds. Success after expiry or cancellation sets the old order to `REFUND_REQUIRED` without consuming inventory or changing another user's reservation. This remains terminal on subsequent events. This is an explicit simulated compensation record; no real charge or refund happens.

If a worker crashes after processing an event but before marking its delivery acknowledged, another worker replays the same ID safely. Multiple workers may deliver a row more than once; this is intentional at-least-once delivery rather than exclusive job claiming.

## Local setup

Use Node.js 22 or newer, pnpm 10, and Docker Compose. The repo already uses pnpm, so keep its lockfile rather than installing with a second package manager.

```sh
pnpm install
# For a fresh checkout. Preserve any existing environment values you need.
cp .env.example .env.local
pnpm db:up
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

`db:up` starts PostgreSQL on port 55432 and the isolated test PostgreSQL on 55433. Only loopback ports are exposed. Development data uses a named volume; test data is temporary. `db:migrate` applies both committed migrations. To author future schema changes, run `pnpm exec prisma migrate dev --name <description>` against your development database.

Run these in separate terminals:

```sh
pnpm dev           # Next.js frontend + Hono API, http://localhost:3000
pnpm dev:workers   # expiry + fake payment gateway, auto-restarts on source edits
```

For a production-mode local check:

```sh
pnpm build
pnpm start
# Separate terminal:
pnpm workers
```

There is no separate API start command. The worker must stay running to deliver payments and proactively allocate expired holds. Restarting Next.js or the workers does not reset database records. The seed is safe to repeat and does not replenish purchased stock.

Both Next.js and command-line processes use `.env.local` before `.env`, with explicitly supplied process variables taking precedence. `.env.example` lists all configuration. Use a private `PAYMENT_WEBHOOK_SECRET` outside the demo. Demo identity is selected with `x-demo-user` and stored locally by the UI. This is impersonation for development, not secure authentication. Setting `DEMO_MODE=false` disables private demo endpoints; it does not implement production authentication.

Stop services with Ctrl+C and `docker compose --profile test down`. Do not add `-v` unless you intend to erase development data.

## API

All responses are JSON except the SSE stream. Errors use `{ "error": { "code": "...", "message": "..." } }`. Request bodies are validated by Zod and JSON parsing errors return `INVALID_REQUEST`.

| Method | Path                     | Request / behavior                                               |
| ------ | ------------------------ | ---------------------------------------------------------------- |
| GET    | `/api/health`            | Database connectivity                                            |
| GET    | `/api/drop`              | Product, stock, held/sold/waiting counts, demo-user list         |
| GET    | `/api/events`            | Public `refresh` SSE invalidations, no private user data         |
| POST   | `/api/reservations`      | `{}`; reserve one pair                                           |
| GET    | `/api/reservations/me`   | Current hold and server time                                     |
| DELETE | `/api/reservations/me`   | Cancel and atomically allocate FIFO                              |
| POST   | `/api/queue`             | `{}`; join waiting queue, idempotent for an existing entry       |
| GET    | `/api/queue/me`          | Stable entry sequence and current one-based waiting rank         |
| POST   | `/api/payments/simulate` | `{ "orderId": "...", "mode": "random" }`                         |
| POST   | `/api/payments/webhook`  | `{ "id": "...", "orderId": "...", "type": "payment.succeeded" }` |
| GET    | `/api/orders/me`         | Latest 100 orders, newest first                                  |

Private demo routes require `x-demo-user: demo-1` (through `demo-24`). The webhook instead requires `Authorization: Bearer <PAYMENT_WEBHOOK_SECRET>`. It accepts only `payment.processing` and `payment.succeeded`; the unsafe old webhook that unconditionally marked arbitrary orders paid has been replaced.

Successful creation uses 201; scheduled simulation uses 202. Missing authentication uses 401, invalid input 400, missing orders 404, and business-state conflicts 409. Stable codes include `OUT_OF_STOCK`, `ACTIVE_RESERVATION_EXISTS`, `PURCHASE_LIMIT_REACHED`, `RESERVATION_EXPIRED`, `ORDER_NOT_FOUND`, `STOCK_AVAILABLE`, `PAYMENT_ALREADY_SCHEDULED`, and `EVENT_ID_CONFLICT`. Unexpected failures do not expose database messages.

Example:

```sh
curl -X POST http://localhost:3000/api/reservations \
  -H 'Content-Type: application/json' -H 'x-demo-user: demo-1' -d '{}'
# Copy reservation.order.id from the response:
curl -X POST http://localhost:3000/api/payments/simulate \
  -H 'Content-Type: application/json' -H 'x-demo-user: demo-1' \
  -d '{"orderId":"COPY_ORDER_ID","mode":"out_of_order"}'
curl http://localhost:3000/api/orders/me -H 'x-demo-user: demo-1'
```

## UI and walkthrough

The storefront shows available/held/sold counts, demo-user selection, a server-deadline countdown, cancel/pay controls, queue rank and order history. The countdown compensates for the difference between the browser and server clock; refresh does not create a new reservation. The current demo identity survives refresh in local storage.

TanStack Query polls every five seconds. The SSE endpoint emits invalidation heartbeats every two seconds, so updates also work when different Next.js and worker processes handle a request. If SSE is interrupted, polling remains active. The countdown is informational: all eligibility decisions happen on the backend.

To demonstrate: reserve as Alex, try success-first delivery, see `PAID`, then switch users. Reserve and cancel another pair to observe stock release. To demonstrate FIFO, exhaust the inventory with distinct users (the tests do this), enqueue additional eligible users, and expire or cancel a hold. The late-delivery mode waits until after the full five-minute deadline; deterministic tests exercise it immediately with an explicit clock.

## Tests and verification

```sh
pnpm db:up
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

`pnpm test` first applies migrations to `TEST_DATABASE_URL`, then runs Vitest. By default this is the separate container on port 55433. The runner and fixtures both require the database name to end in `_test`. Tests truncate all application tables in that database between cases. Never point it at data you want to retain. Watch mode is `pnpm test:watch`.

The suite submits 1,000 concurrent requests to the actual Hono reservation handler against PostgreSQL and expects exactly 20 successes and 980 `OUT_OF_STOCK` conflicts. Other tests cover concurrent same-user requests, the two-pair cap, SQL constraints, transaction rollback, idempotent expiry, payment/expiry and cancellation/payment races, FIFO/fresh deadlines, stale queue entries, queue idempotency, duplicate and out-of-order payments, late compensation after reassignment, gateway persistence/replay, order ownership and HTTP auth/validation. Time-sensitive tests use explicit clocks or timestamps, not a five-minute sleep.

The concurrency test is a correctness test, not a production throughput benchmark. No claim is made about sustaining 1,000 requests per second.

## Limits and production work

This is a development demo for a single product. Production needs verified authentication, authorization, rate limits and admission control for a flash-sale spike, real payment signatures/refunds, operational metrics and alerts, and load testing on the deployed database. An invalid or permanently failing delivery currently retries indefinitely with its error state retained; an operations view and dead-letter policy would be needed. The worker has no distributed scheduler dependency, but should run under a process supervisor. PostgreSQL provides transaction correctness; deployment-specific SSE timeouts still require the polling fallback.

There is no shoe-size selection, shipping, price calculation, real payment integration or cross-product inventory. A refund-required order records that simulated compensation is necessary; it does not fulfill a shoe. Editing stock directly, deleting historical purchases, or adding a new write path outside the shared locking discipline can break the application invariants.

## Optional browser walkthrough recording

With Next.js running on port 3100 (`pnpm start --port 3100`) and a worker running:

```sh
pnpm exec playwright install chromium
pnpm demo:record
```

The script reserves and purchases a real demo pair as `demo-6`, checks that both identity and reservation deadline survive refresh, verifies out-of-order payment completion, checks mobile overflow, and writes screenshots plus `artifacts/walkthrough.webm`. It consumes one pair and one of that demo user's two purchases; it does not reset or erase the database. Run it against a fresh eligible demo user state. `DEMO_URL` changes the origin; `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an already installed Chromium binary. Artifacts are ignored by Git.

## Verification performed

The implementation was verified with both committed migrations applied to the Docker development and test databases, Prisma client generation (including without a database URL), and repeated seeding. All 23 Vitest/PostgreSQL tests passed, including the 1,000-request Hono concurrency test with exactly 20 successful reservations and 980 out-of-stock responses. TypeScript, ESLint and the Next.js production build passed.

The Playwright walkthrough ran against production-mode Next.js with the worker running. Reservation creation, persistence of the user/deadline across reload, payment completion despite out-of-order events, absence of browser runtime errors, and mobile horizontal layout passed. Actual screenshots and a WebM recording were produced in `artifacts/`. The walkthrough purchased one pair as `demo-6`; the local development database consequently has 19 available pairs and one paid order. Re-seeding deliberately preserves that state.
