import type { Logger } from "./platform/logger";

export type BusinessContext = { id: string; role: "owner" | "accountant" | "staff" };

export type AppEnv = {
  Variables: { requestId: string; log: Logger; user: { id: string }; business: BusinessContext };
};
