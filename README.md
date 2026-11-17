# BillDrop API

Backend for BillDrop: a Hono HTTP API plus a pg-boss job worker, on Bun and TypeScript, backed by
PostgreSQL and S3-compatible object storage (Cloudflare R2 in production, MinIO locally). One codebase,
two roles selected with `--role=api` or `--role=worker`.

Product, architecture and data-model documents live in [`../docs`](../docs), starting with
[`SYSTEM_DESIGN.md`](../docs/SYSTEM_DESIGN.md) and [`IMPLEMENTATION_PLAN_API.md`](../docs/IMPLEMENTATION_PLAN_API.md).

## Prerequisites

- [Bun](https://bun.sh) 1.4.4
- Docker (for the local Postgres 17 and MinIO)

## Getting started

```sh
bun install
docker compose -f compose.dev.yml up -d   # Postgres on :5433, MinIO on :9000 (console :9001)
bun run dev:buckets                       # creates the billdrop-dev and billdrop-test buckets
export DATABASE_URL=postgres://billdrop:billdrop@localhost:5433/billdrop
bun run migrate
```

Run the API (`bun run dev`) with at least this environment:

```sh
NODE_ENV=development
DATABASE_URL=postgres://billdrop:billdrop@localhost:5433/billdrop
S3_ENDPOINT=http://localhost:9000
R2_ACCESS_KEY_ID=billdrop
R2_SECRET_ACCESS_KEY=billdrop-dev-secret
R2_BUCKET=billdrop-dev
```

### Everything in Docker (no local Bun needed)

```sh
docker compose -f compose.dev.yml --profile full up -d --build   # Postgres, MinIO, buckets, migrations, API, worker
curl http://localhost:3000/ready                                 # {"status":"ready"}
docker compose -f compose.dev.yml --profile full logs -f api worker  # follow API and worker logs
docker compose -f compose.dev.yml --profile full down            # stop (add -v to wipe data)
```

The API listens on all interfaces at port 3000, so a phone on the same Wi-Fi reaches it at
`http://<PC's IPv4 from ipconfig>:3000`. Its environment, including the demo login, is set in `compose.dev.yml`
(`x-api-env`); no `.env` file is needed. Rebuild with `--build` after changing code.

The full key list for deployed environments is in [`DEPLOYMENT_OPS.md` section 3](../docs/DEPLOYMENT_OPS.md).
Optional keys: `PORT` (3000), `DB_POOL_SIZE` (10), `METRICS_PORT` (9100), `LOG_LEVEL` (info). In production
set `R2_ACCOUNT_ID` instead of `S3_ENDPOINT`. Every value is validated at startup.

The `full` profile also runs the worker (bill extraction). It needs `GEMINI_API_KEY` in the shell or in `api/.env` (compose reads it; never commit it); `AI_MODEL` (gemini-3.8-flash) and `AI_MAX_CONCURRENCY` (4) are optional. Without a key, bills fail with `ai_error`.

Start the worker alone with `bun run src/main.ts --role=worker` (use a different `METRICS_PORT` if the API runs on
the same machine). Prometheus metrics are served on `METRICS_PORT` at `/metrics`, never on the public port.

## Demo login (temporary)

A stopgap email/password login so the app can sign in before Google/Apple auth (phase A3) exists. A12.6 removes it, before the first production deploy.
The routes (`POST /v1/auth/demo-login`, `POST /v1/auth/refresh`, `GET /v1/me`) are only mounted when enabled;
otherwise they return 404. Enabling it with `NODE_ENV=production` is a startup error.

```sh
DEMO_LOGIN_ENABLED=true
DEMO_EMAIL=demo@billdrop.app
DEMO_PASSWORD=Demo@1234        # min 8 chars
JWT_SECRET=<at least 32 random chars>
```

```sh
curl -s localhost:3000/v1/auth/demo-login -H 'content-type: application/json' \
  -d '{"email":"demo@billdrop.app","password":"Demo@1234"}'
curl -s localhost:3000/v1/me -H "authorization: Bearer $ACCESS_TOKEN"
curl -s localhost:3000/v1/auth/refresh -H 'content-type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}"
```

Access tokens last 12 h, refresh tokens 30 days. Login is limited to 10 attempts per minute per client IP.

The API listens on `0.0.0.0:3000`. Reaching it from a phone:

- Android emulator: `http://10.0.2.2:3000`
- USB device: `adb reverse tcp:3000 tcp:3000`, then `http://localhost:3000`
- Same Wi-Fi: `http://<PC LAN IP>:3000` (Windows Firewall may prompt; allow private networks)

## Scripts

| Command                           | What it does                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `bun run dev`                     | API with file watching                                                                  |
| `bun run start`                   | API, no watching                                                                        |
| `bun run migrate`                 | Applies `drizzle/` migrations under a Postgres advisory lock (safe to run concurrently) |
| `bun run dev:buckets`             | Creates the MinIO buckets used for development and tests                                |
| `bun run typecheck`               | `tsc --noEmit`                                                                          |
| `bun run lint` / `bun run format` | Biome check / format                                                                    |
| `bun test`                        | All tests                                                                               |

## Tests

Pure unit tests (money, GST, financial year, pagination, config, HTTP) need nothing running. Integration
tests (database, queue, storage) need the compose stack:

```sh
docker compose -f compose.dev.yml up -d
bun test
```

The harness in `test/setup.ts` creates the `billdrop_test` database if it is missing, applies migrations
once per run, and creates the `billdrop-test` bucket. Override with `TEST_DATABASE_URL`, `S3_ENDPOINT`,
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Use `withRollback(fn)` to run a test inside a transaction that
is always rolled back.

## Layout

```
src/
  main.ts, worker.ts     entry point and worker bootstrap
  app.ts                 Hono app, probes (/health, /ready)
  http/                  middleware, error handling, OpenAPI
  platform/              config, logger, db (drizzle + postgres.js), queue (pg-boss), storage (R2), metrics
  shared/                money, ids, gst, fy, pagination
  modules/               feature modules (auth, businesses, bills, ...)
drizzle/                 SQL migrations
test/                    integration harness and factories
deploy/                  production compose files, Caddyfile, scripts
contract/                published OpenAPI and math vectors
```
