import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env";
import { parseJsonBody } from "../../http/validate";
import { notFound } from "../../platform/errors";
import { createExportSchema, exportToView } from "./exports.schema";
import {
  createExport,
  type ExportsDeps,
  getExport,
  getExportDownload,
  listExports,
} from "./exports.service";

const uuidParam = z.string().uuid();
const idParam = (raw: string | undefined): string => {
  const parsed = uuidParam.safeParse(raw);
  if (!parsed.success) throw notFound("Export not found");
  return parsed.data;
};

export function exportsRoutes(deps: ExportsDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // POST /v1/exports
  routes.post("/", async (c) => {
    const input = await parseJsonBody(createExportSchema, c.req.raw);
    const business = c.get("business");
    const user = c.get("user");

    const { record, downloadUrl } = await createExport(deps, business.id, user.id, input);
    const view = exportToView(record, downloadUrl);
    return c.json({ ...view, export: view }, 202);
  });

  // GET /v1/exports
  routes.get("/", async (c) => {
    const business = c.get("business");
    const limitQuery = c.req.query("limit");
    const limit = limitQuery ? Math.min(Math.max(Number(limitQuery) || 20, 1), 100) : 20;

    const records = await listExports(deps, business.id, limit);
    const items = records.map((r) => {
      const downloadUrl =
        r.status === "ready" && r.storageKey
          ? deps.storage.presignGet(r.storageKey, 300)
          : undefined;
      return exportToView(r, downloadUrl);
    });

    return c.json({ items });
  });

  // GET /v1/exports/:id
  routes.get("/:id", async (c) => {
    const business = c.get("business");
    const id = idParam(c.req.param("id"));

    const { record, downloadUrl } = await getExport(deps, business.id, id);
    const view = exportToView(record, downloadUrl);
    return c.json({ ...view, export: view });
  });

  // GET /v1/exports/:id/download
  routes.get("/:id/download", async (c) => {
    const business = c.get("business");
    const id = idParam(c.req.param("id"));

    const { downloadUrl, stream, contentType, filename } = await getExportDownload(
      deps,
      business.id,
      id,
    );

    if (c.req.query("redirect") === "true") {
      return c.redirect(downloadUrl, 302);
    }

    return new Response(stream, {
      headers: {
        "content-type": contentType,
        "content-disposition": `attachment; filename="${filename}"`,
        "x-download-url": downloadUrl,
      },
    });
  });

  return routes;
}
