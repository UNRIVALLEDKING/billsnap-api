import { describe, expect, test } from "bun:test";
import { type Action, can } from "./policy";

describe("RBAC Permissions Policy", () => {
  const allActions: Action[] = [
    "bill.drop",
    "bill.view_own",
    "bill.view_all",
    "bill.edit",
    "bill.confirm",
    "catalog.merge",
    "export",
    "business.manage",
  ];

  test("owner has full permissions across all actions", () => {
    for (const action of allActions) {
      expect(can("owner", action)).toBe(true);
    }
  });

  test("accountant can view, edit, confirm, merge and export, but cannot manage business", () => {
    expect(can("accountant", "bill.drop")).toBe(true);
    expect(can("accountant", "bill.view_own")).toBe(true);
    expect(can("accountant", "bill.view_all")).toBe(true);
    expect(can("accountant", "bill.edit")).toBe(true);
    expect(can("accountant", "bill.confirm")).toBe(true);
    expect(can("accountant", "catalog.merge")).toBe(true);
    expect(can("accountant", "export")).toBe(true);
    expect(can("accountant", "business.manage")).toBe(false);
  });

  test("staff can drop, view own, and edit bills", () => {
    expect(can("staff", "bill.drop")).toBe(true);
    expect(can("staff", "bill.view_own")).toBe(true);
    expect(can("staff", "bill.edit")).toBe(true);
  });

  test("staff cannot view all, merge, export, or manage business", () => {
    expect(can("staff", "bill.view_all")).toBe(false);
    expect(can("staff", "catalog.merge")).toBe(false);
    expect(can("staff", "export")).toBe(false);
    expect(can("staff", "business.manage")).toBe(false);
  });

  test("staff can only confirm if staffCanConfirm option is true", () => {
    expect(can("staff", "bill.confirm")).toBe(false);
    expect(can("staff", "bill.confirm", { staffCanConfirm: false })).toBe(false);
    expect(can("staff", "bill.confirm", { staffCanConfirm: true })).toBe(true);
  });
});
