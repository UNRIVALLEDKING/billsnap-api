import pino, { type Logger } from "pino";

export type { Logger };

// PRIV-4: never log tokens, cookies or authorization headers.
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.token",
  "*.refresh_token",
  "*.access_token",
  "*.password",
  "cookie",
];

export function createLogger(opts: {
  level: string;
  destination?: pino.DestinationStream;
}): Logger {
  return pino(
    {
      level: opts.level,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    opts.destination,
  );
}
