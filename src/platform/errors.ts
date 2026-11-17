export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (message = "Resource not found") => new AppError("not_found", 404, message);
export const badRequest = (message: string) => new AppError("bad_request", 400, message);
export const unauthorized = (message = "Authentication required") =>
  new AppError("unauthorized", 401, message);
export const forbidden = (message = "Not allowed") => new AppError("forbidden", 403, message);
export const unauthenticated = (message = "Authentication required") =>
  new AppError("unauthenticated", 401, message);
