import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../../app-env";
import type { Logger } from "../../platform/logger";

/** Attaches a request-scoped child logger and logs one line per request (path only, no query string). */
export const requestLog = (logger: Logger) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const log = logger.child({ request_id: c.get("requestId") });
    c.set("log", log);
    const start = performance.now();
    await next();
    log.info(
      {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        duration_ms: Math.round(performance.now() - start),
      },
      "request",
    );
  });
