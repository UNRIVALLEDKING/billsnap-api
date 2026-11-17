import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./app-env";
import { requireAuth } from "./http/middleware/auth";
import { businessContext } from "./http/middleware/business-context";
import { errorHandler, notFoundHandler } from "./http/middleware/error-handler";
import { requestId } from "./http/middleware/request-id";
import { requestLog } from "./http/middleware/request-log";
import { openApiDocument } from "./http/openapi";
import { authRoutes } from "./modules/auth/auth.routes";
import { type DemoConfig, demoLoginRoutes } from "./modules/auth/demo-login";
import { billsRoutes } from "./modules/bills/bills.routes";
import { businessRoutes } from "./modules/businesses/businesses.routes";
import { productRoutes, vendorRoutes } from "./modules/catalog/catalog.routes";
import { devicesRoutes } from "./modules/devices/devices.routes";
import { exportsRoutes } from "./modules/exports/exports.routes";
import {
  catalogInitializationRoutes,
  feeRoutes,
  inventoryRoutes,
} from "./modules/inventory/inventory.routes";
import { invitesRoutes, memberRoutes } from "./modules/invites/invites.routes";
import type { Database } from "./platform/db/client";
import type { Logger } from "./platform/logger";
import { httpMetrics, type Metrics } from "./platform/metrics";
import type { Queue } from "./platform/queue";
import type { Storage } from "./platform/storage/r2";

export type AppState = { shuttingDown: boolean };

export type AppDeps = {
  logger: Logger;
  state: AppState;
  db: { ping(): Promise<void> };
  metrics: Metrics;
  /** TEMPORARY: set only when DEMO_LOGIN_ENABLED=true; phase A3 replaces it. */
  demo?: DemoConfig | undefined;
  /** Bill and catalog routes are mounted only when both demo auth and this are present. */
  data?: { database: Database; storage: Storage; queue: Queue } | undefined;
};

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Middleware order: metrics -> request-id -> request log -> secure headers (auth, rate-limit etc. arrive later).
  app.use(httpMetrics(deps.metrics));
  app.use(requestId);
  app.use(requestLog(deps.logger));
  app.use(secureHeaders());

  // Operational probes live at the root (not under /v1): API_SPEC lists them unversioned
  // and Caddy / Docker health checks hit them directly.
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    if (deps.state.shuttingDown) return c.json({ status: "shutting_down" }, 503);
    try {
      await deps.db.ping();
    } catch (err) {
      c.get("log").warn({ err }, "readiness: database unreachable");
      return c.json({ status: "db_unavailable" }, 503);
    }
    return c.json({ status: "ready" });
  });

  app.get("/v1/openapi.json", (c) => c.json(openApiDocument));

  if (deps.demo && deps.data) {
    app.route(
      "/",
      authRoutes({
        database: deps.data.database,
        jwtSecret: deps.demo.jwtSecret,
        demo: deps.demo,
      }),
    );
  } else if (deps.demo) {
    app.route("/", demoLoginRoutes(deps.demo));
  }

  if (deps.demo && deps.data) {
    const { database, storage, queue } = deps.data;
    // Per-prefix guards (not a blanket /v1/*), so the unauthenticated /v1/auth routes stay open.
    const guards = [requireAuth(deps.demo.jwtSecret), businessContext(database.db)];
    for (const base of [
      "/v1/bills",
      "/v1/vendors",
      "/v1/products",
      "/v1/inventory",
      "/v1/exports",
      "/v1/fees",
      "/v1/business",
    ]) {
      app.use(base, ...guards);
      app.use(`${base}/*`, ...guards);
    }
    app.route("/v1/bills", billsRoutes({ database, storage, queue }));
    app.route("/v1/vendors", vendorRoutes(database));
    app.route("/v1/products", productRoutes(database));
    app.route("/v1/inventory", inventoryRoutes(database));
    app.route("/v1/exports", exportsRoutes({ database, storage, queue, logger: deps.logger }));
    app.route("/v1/fees", feeRoutes(database));
    app.route("/v1/business", catalogInitializationRoutes(database));

    app.use("/v1/businesses", requireAuth(deps.demo.jwtSecret));
    app.use("/v1/businesses/*", requireAuth(deps.demo.jwtSecret));
    app.use("/v1/businesses/initialize-catalog", businessContext(database.db));
    app.route("/v1/businesses", catalogInitializationRoutes(database));
    app.route("/v1/businesses", memberRoutes(database));
    app.route("/v1/businesses", businessRoutes(database));

    app.route("/v1/invites", invitesRoutes({ database, jwtSecret: deps.demo.jwtSecret }));

    app.use("/v1/me/devices", requireAuth(deps.demo.jwtSecret));
    app.use("/v1/me/devices/*", requireAuth(deps.demo.jwtSecret));
    app.route("/v1/me/devices", devicesRoutes());
  }

  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  return app;
}
