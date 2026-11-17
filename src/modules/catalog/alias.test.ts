import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env";
import { errorHandler } from "../../http/middleware/error-handler";
import type { Database } from "../../platform/db/client";
import { newId } from "../../shared/ids";
import { productRoutes, vendorRoutes } from "./catalog.routes";
import { removeProductAlias, removeVendorAlias } from "./catalog.service";

describe("Vendor & Product OCR Alias Management", () => {
  const businessId = newId();
  const vendorId = newId();
  const productId = newId();

  test("removeVendorAlias prevents removing the surviving vendor display name", async () => {
    const mockDb = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return [{ displayName: "Krishna Provisions", nameNorm: "krishna provisions" }];
                  },
                };
              },
            };
          },
        };
      },
    };

    // Attempting to remove display name itself must fail
    await expect(
      removeVendorAlias(
        mockDb as unknown as Database["db"],
        businessId,
        vendorId,
        "Krishna Provisions",
      ),
    ).rejects.toThrow("Cannot remove surviving vendor display name");

    // Case-insensitive check
    await expect(
      removeVendorAlias(
        mockDb as unknown as Database["db"],
        businessId,
        vendorId,
        "krishna provisions",
      ),
    ).rejects.toThrow("Cannot remove surviving vendor display name");
  });

  test("removeVendorAlias removes an alias and rejects if not found", async () => {
    let deletedRows: unknown[] = [];
    const mockDb = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return [{ displayName: "Krishna Provisions", nameNorm: "krishna provisions" }];
                  },
                };
              },
            };
          },
        };
      },
      delete() {
        return {
          where() {
            return {
              returning() {
                return deletedRows;
              },
            };
          },
        };
      },
    };

    // When no alias rows are deleted -> 404
    deletedRows = [];
    await expect(
      removeVendorAlias(mockDb as unknown as Database["db"], businessId, vendorId, "Old OCR Spell"),
    ).rejects.toThrow("Alias not found");

    // When alias is deleted successfully
    deletedRows = [{ id: newId() }];
    await expect(
      removeVendorAlias(mockDb as unknown as Database["db"], businessId, vendorId, "Old OCR Spell"),
    ).resolves.toBeUndefined();
  });

  test("removeProductAlias prevents removing the surviving product display name", async () => {
    const mockDb = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return [{ displayName: "Basmati Rice 25kg", nameNorm: "basmati rice 25kg" }];
                  },
                };
              },
            };
          },
        };
      },
    };

    await expect(
      removeProductAlias(
        mockDb as unknown as Database["db"],
        businessId,
        productId,
        "Basmati Rice 25kg",
      ),
    ).rejects.toThrow("Cannot remove surviving product display name");
  });

  test("removeProductAlias removes alias and rejects if not found", async () => {
    let deletedRows: unknown[] = [];
    const mockDb = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return [{ displayName: "Basmati Rice 25kg", nameNorm: "basmati rice 25kg" }];
                  },
                };
              },
            };
          },
        };
      },
      delete() {
        return {
          where() {
            return {
              returning() {
                return deletedRows;
              },
            };
          },
        };
      },
    };

    deletedRows = [];
    await expect(
      removeProductAlias(mockDb as unknown as Database["db"], businessId, productId, "Rice 25 Kgs"),
    ).rejects.toThrow("Alias not found");

    deletedRows = [{ id: newId() }];
    await expect(
      removeProductAlias(mockDb as unknown as Database["db"], businessId, productId, "Rice 25 Kgs"),
    ).resolves.toBeUndefined();
  });

  describe("HTTP Routes Integration", () => {
    function createTestApp() {
      const mockDatabase = {
        db: {
          select() {
            return {
              from() {
                return {
                  where() {
                    return {
                      limit() {
                        return [
                          { displayName: "Krishna Provisions", nameNorm: "krishna provisions" },
                        ];
                      },
                    };
                  },
                };
              },
            };
          },
          delete() {
            return {
              where() {
                return {
                  returning() {
                    return [{ id: newId() }];
                  },
                };
              },
            };
          },
        },
        tx(fn: unknown) {
          return (fn as (ctx: { db: unknown }) => unknown)({ db: mockDatabase.db });
        },
      } as unknown as Database;

      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("business", {
          id: businessId,
          role: "owner",
        });
        c.set("user", { id: newId() });
        await next();
      });

      app.route("/v1/vendors", vendorRoutes(mockDatabase));
      app.route("/v1/products", productRoutes(mockDatabase));
      app.onError(errorHandler);
      return app;
    }

    test("DELETE /v1/vendors/:id/aliases/:alias returns 200 with status ok", async () => {
      const app = createTestApp();
      const res = await app.request(`/v1/vendors/${vendorId}/aliases/Old%20Misspelled%20Name`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    });

    test("DELETE /v1/products/:id/aliases/:alias returns 200 with status ok", async () => {
      const app = createTestApp();
      const res = await app.request(`/v1/products/${productId}/aliases/Basmati%205kg`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    });
  });
});
