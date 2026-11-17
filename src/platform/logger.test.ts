import { expect, test } from "bun:test";
import { createLogger } from "./logger";

test("logger redacts tokens and authorization", () => {
  const lines: string[] = [];
  const log = createLogger({ level: "info", destination: { write: (s) => void lines.push(s) } });
  log.info(
    {
      req: { headers: { authorization: "Bearer abc" } },
      user: { token: "t1", refresh_token: "t2" },
    },
    "x",
  );
  const out = lines.join("");
  expect(out).not.toContain("Bearer abc");
  expect(out).not.toContain("t1");
  expect(out).not.toContain("t2");
  expect(out).toContain("[redacted]");
});
