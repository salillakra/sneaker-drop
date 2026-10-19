# Sneaker Drop

A 20-pair limited sale with five-minute holds, FIFO allocation, a two-pair purchase cap, and durable simulated payment events. Built in the existing **Next.js + Hono + Prisma + PostgreSQL** application. No separate API server.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the repository map, API routes, data model, runtime and workflow diagrams, and file-by-file guide.

```sh
pnpm install
cp .env.example .env.local  # fresh checkout; preserve existing configuration
pnpm db:up
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

In another terminal, run `pnpm dev:workers`. Open http://localhost:3000 and select a demo user. Both the API and storefront are served by Next.js; the worker only processes expiry and persisted fake payment deliveries.

```sh
pnpm test        # real PostgreSQL tests; isolated database on port 55433
pnpm typecheck
pnpm lint
pnpm build
pnpm start       # production-mode Next.js
pnpm workers     # production-mode worker, separate terminal
```

Read [NOTES.md](NOTES.md) for the locking strategy, payment semantics, API, setup, tests, walkthrough and limitations. Authentication and payments are explicitly for development.

## Vercel deployment

The Next.js storefront and Hono API deploy together. `vercel.json` also declares
one Vercel Daemon that builds the root `Dockerfile` and runs the existing worker.
Both use the production `DATABASE_URL`, `DEMO_MODE`, `PAYMENT_WEBHOOK_SECRET`,
and `WORKER_INTERVAL_MS` environment variables. Environment files are excluded
from Git, Vercel uploads, and the worker image.

Before deploying to a new database, run `pnpm db:migrate` and `pnpm db:seed`
with that database's credentials. Deploy with `vercel --prod`. Daemons are
currently in beta and run only in production, so preview deployments do not
process background jobs. Use an isolated database if adding preview environments.

To validate the worker image locally:

```sh
docker build -t sneaker-drop-worker .
docker run --rm --env-file worker.env sneaker-drop-worker
```

Create an untracked `worker.env` with the required variables in Docker's
`KEY=value` format (without quotes around values). Keep it outside the repository.
