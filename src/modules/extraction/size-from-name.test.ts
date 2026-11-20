import { describe, expect, test } from "bun:test";
import type { NameSize } from "./size-from-name";
import { sizeFromName } from "./size-from-name";
import fixtures from "./size-from-name.fixtures.json";

describe("sizeFromName fixtures", () => {
  for (const f of fixtures as { name: string; expected: NameSize | null }[]) {
    test(f.name, () => {
      expect(sizeFromName(f.name)).toEqual(f.expected);
    });
  }
});
