import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    ROLE: z.enum(["api", "worker"]).optional(),
    DATABASE_URL: z.string().min(1),
    DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9100),
    // Object storage: Cloudflare R2 in production (R2_ACCOUNT_ID), any S3 endpoint (MinIO) via S3_ENDPOINT.
    R2_ACCOUNT_ID: z.string().min(1).optional(),
    S3_ENDPOINT: z.url().optional(),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_BUCKET: z.string().min(1),
    // AI extraction. Without a key the worker fails bills with ai_error instead of crashing.
    GEMINI_API_KEY: z
      .string()
      .optional()
      .transform((v) => v?.trim() || undefined),
    AI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
    AI_FALLBACK_MODEL: z.string().min(1).default("gemini-3.8-flash"),
    AI_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    // TEMPORARY demo login (phase A3 replaces it with Google/Apple). Never enabled in production.
    DEMO_LOGIN_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    DEMO_EMAIL: z.email().optional(),
    DEMO_PASSWORD: z.string().min(8).optional(),
    JWT_SECRET: z.string().min(32).optional(),
  })
  .refine((c) => c.R2_ACCOUNT_ID || c.S3_ENDPOINT, {
    path: ["R2_ACCOUNT_ID"],
    message: "set R2_ACCOUNT_ID (or S3_ENDPOINT for MinIO)",
  })
  .superRefine((c, ctx) => {
    if (!c.DEMO_LOGIN_ENABLED) return;
    if (c.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["DEMO_LOGIN_ENABLED"],
        message: "must not be enabled when NODE_ENV=production",
      });
    }
    for (const key of ["DEMO_EMAIL", "DEMO_PASSWORD", "JWT_SECRET"] as const) {
      if (!c[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "required when DEMO_LOGIN_ENABLED=true",
        });
      }
    }
  });

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Validates env vars; throws ConfigError naming every missing or invalid key. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((i) => {
      const key = i.path.join(".") || "(root)";
      return env[key] === undefined ? `${key}: missing (${i.message})` : `${key}: ${i.message}`;
    }),
  );
}
