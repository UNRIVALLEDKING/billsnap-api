import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../app-env";
import { AppError } from "../../platform/errors";

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

/** RFC 9457 problem details with a stable machine-readable `code`. */
function problem(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, string> = {},
  fields: Record<string, unknown> = {},
): Response {
  const body = {
    ...fields,
    type: `urn:billdrop:problem:${code}`,
    title: TITLES[status] ?? "Error",
    status,
    code,
    detail,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extra, "Content-Type": "application/problem+json" },
  });
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof AppError)
    return problem(err.status, err.code, err.message, err.headers, err.fields);
  if (err instanceof HTTPException) {
    return problem(
      err.status,
      err.status === 413 ? "payload_too_large" : "http_error",
      err.message,
    );
  }
  // Unknown error: log it, never leak message or stack to the client.
  c.get("log")?.error({ err }, "unhandled error");
  return problem(500, "internal", "Internal server error");
};

export const notFoundHandler: NotFoundHandler<AppEnv> = () =>
  problem(404, "not_found", "Route not found");
