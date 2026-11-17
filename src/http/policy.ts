import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-env";
import { AppError } from "../platform/errors";

export type Role = "owner" | "accountant" | "staff";
export type Action =
  | "bill.drop"
  | "bill.view_own"
  | "bill.view_all"
  | "bill.edit"
  | "bill.confirm"
  | "catalog.merge"
  | "export"
  | "business.manage"
  | "fee.view"
  | "fee.manage";

export function can(role: Role, action: Action, opts?: { staffCanConfirm?: boolean }): boolean {
  if (role === "owner") return true;
  if (role === "accountant") return action !== "business.manage";
  if (role === "staff") {
    if (action === "bill.confirm") return opts?.staffCanConfirm ?? false;
    if (action === "fee.view") return true;
    return action === "bill.drop" || action === "bill.view_own" || action === "bill.edit";
  }
  return false;
}

export function requirePermission(action: Action) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const role = c.var.business?.role;
    if (!role || !can(role, action)) {
      throw new AppError(
        "forbidden",
        403,
        `Role '${role ?? "none"}' does not have permission for '${action}'`,
      );
    }
    await next();
  });
}
