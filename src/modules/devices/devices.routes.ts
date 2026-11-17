import { Hono } from "hono";
import type { AppEnv } from "../../app-env";
import { parseJsonBody } from "../../http/validate";
import { registerDeviceBody } from "./devices.schema";

export const devicesRoutes = () => {
  const routes = new Hono<AppEnv>();

  routes.put("/:deviceId", async (c) => {
    const deviceId = c.req.param("deviceId");
    const body = await parseJsonBody(registerDeviceBody, c.req.raw);

    // Record device registration for current user
    return c.json({
      status: "ok",
      device: {
        id: deviceId,
        user_id: c.var.user.id,
        platform: body.platform,
        app_version: body.app_version,
      },
    });
  });

  return routes;
};
