import { z } from "zod";

export const registerDeviceBody = z.object({
  platform: z.enum(["android", "ios"]),
  fcm_token: z.string().trim().min(10).max(500),
  app_version: z.string().trim().min(1).max(50),
});

export type RegisterDeviceInput = z.infer<typeof registerDeviceBody>;
