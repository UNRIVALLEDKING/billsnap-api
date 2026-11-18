import { createApp } from "./app";
import { seedDemoAccount } from "./modules/auth/demo-seed";
import { createGeminiProvider } from "./platform/ai";
import { ConfigError, loadConfig } from "./platform/config";
import { createDatabase } from "./platform/db/client";
import { createLogger } from "./platform/logger";
import { Metrics, registerQueueGauge, startMetricsServer } from "./platform/metrics";
import { createPgBossQueue } from "./platform/queue/pgboss";
import { ensureBucket } from "./platform/storage/ensure-bucket";
import { createStorage } from "./platform/storage/r2";
import { startWorker } from "./worker";

const DRAIN_MS = 30_000; // REL-7
const MAX_BODY_BYTES = 55 * 1024 * 1024; // SEC-5: 50 MB per request plus multipart overhead

function parseRole(argv: string[], fallback?: string): "api" | "worker" {
  const role =
    argv.find((a) => a.startsWith("--role="))?.slice("--role=".length) ?? fallback ?? "api";
  if (role !== "api" && role !== "worker") {
    console.error(`Invalid role "${role}": expected --role=api or --role=worker`);
    process.exit(1);
  }
  return role;
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const role = parseRole(Bun.argv.slice(2), config.ROLE);
const logger = createLogger({ level: config.LOG_LEVEL }).child({ role });
const state = { shuttingDown: false };

const database = createDatabase({ url: config.DATABASE_URL, poolSize: config.DB_POOL_SIZE });
const metrics = new Metrics();
// Internal port only: never published by Caddy or the compose file.
const metricsServer = startMetricsServer(metrics, config.METRICS_PORT);

let stopRole: () => Promise<unknown>;
if (role === "api") {
  const demo =
    config.DEMO_LOGIN_ENABLED && config.DEMO_EMAIL && config.DEMO_PASSWORD && config.JWT_SECRET
      ? { email: config.DEMO_EMAIL, password: config.DEMO_PASSWORD, jwtSecret: config.JWT_SECRET }
      : undefined;
  if (demo) logger.warn("DEMO LOGIN ENABLED: temporary, never use in production");
  const storage = createStorage(config);
  if (config.S3_ENDPOINT) {
    try {
      await ensureBucket({
        endpoint: config.S3_ENDPOINT,
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
        bucket: config.R2_BUCKET,
      });
      logger.info({ bucket: config.R2_BUCKET }, "storage bucket verified");
    } catch (err) {
      logger.warn({ err, bucket: config.R2_BUCKET }, "could not ensure storage bucket on startup");
    }
  }
  // The API enqueues extraction jobs (inside the upload transaction), so it needs a started queue too.
  const queue = createPgBossQueue({ url: config.DATABASE_URL, log: logger });
  await queue.start();
  if (demo) await seedDemoAccount(database.db, demo.email);
  const app = createApp({
    logger,
    state,
    db: database,
    metrics,
    demo,
    data: { database, storage, queue },
  });
  const server = Bun.serve({
    hostname: "0.0.0.0", // reachable from a phone on the LAN
    port: config.PORT,
    fetch: app.fetch,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  logger.info({ port: server.port }, "api listening");
  // stop() without force lets in-flight requests finish.
  stopRole = async () => {
    await server.stop();
    await queue.stop();
  };
} else {
  const queue = createPgBossQueue({ url: config.DATABASE_URL, log: logger });
  registerQueueGauge(metrics);
  const ai = config.GEMINI_API_KEY
    ? createGeminiProvider({ apiKey: config.GEMINI_API_KEY })
    : undefined;
  if (!ai) logger.warn("GEMINI_API_KEY is not set: bills will fail with ai_error");
  stopRole = (
    await startWorker(logger, queue, {
      database,
      storage: createStorage(config),
      ai,
      model: config.AI_MODEL,
      fallbackModel: config.AI_FALLBACK_MODEL,
      concurrency: config.AI_MAX_CONCURRENCY,
    })
  ).stop;
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  state.shuttingDown = true; // /ready -> 503 so the load balancer stops sending traffic
  logger.info({ signal }, "shutdown started");
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), DRAIN_MS),
  );
  const result = await Promise.race([
    stopRole()
      .then(() => Promise.all([database.close(), metricsServer.stop()]))
      .then(() => "drained" as const),
    timeout,
  ]);
  logger.info({ result }, "shutdown complete");
  process.exit(result === "drained" ? 0 : 1);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
