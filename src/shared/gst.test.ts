import { describe, expect, test } from "bun:test";
import {
  GST_RATES,
  gstinCheckChar,
  gstinState,
  isValidGstin,
  isValidGstRate,
  STATE_CODES,
} from "./gst";

// Publicly listed GSTINs of well-known companies; the checksums match the mod-36 algorithm.
const VALID = [
  "27AAPFU0939F1ZV",
  "29AAGCB7383J1Z4",
  "27AAACR5055K1Z7",
  "24AAACC1206D1ZM",
  "27AAACT2727Q1ZW",
  "29AAACH7409R1ZX",
];

describe("isValidGstin", () => {
  test.each(VALID)("accepts %s", (g) => {
    expect(isValidGstin(g)).toBe(true);
  });

  test("rejects a wrong check character", () => {
    expect(isValidGstin("29AAGCB7383J1Z5")).toBe(false);
    expect(isValidGstin("27AAPFU0939F1ZA")).toBe(false);
  });

  test("rejects a single-character typo in the body", () => {
    expect(isValidGstin("27AAPFU0939F1ZV".replace("0939", "0938"))).toBe(false);
  });

  test("rejects bad shape", () => {
    for (const bad of [
      "",
      "27AAPFU0939F1Z",
      "27AAPFU0939F1ZVV",
      "27aapfu0939f1zv",
      "27AAPFU0939F1XV",
      "27AAPF10939F1ZV",
      "27AAPFU0939F0ZV",
    ]) {
      expect(isValidGstin(bad)).toBe(false);
    }
  });

  test("rejects an unknown state code even with a correct checksum", () => {
    const body = "25AAPFU0939F1Z";
    expect(isValidGstin(body + gstinCheckChar(body))).toBe(false);
  });
});

describe("gstinState", () => {
  test("maps the first two digits", () => {
    expect(gstinState("27AAPFU0939F1ZV")).toEqual({ code: "27", name: "Maharashtra" });
    expect(gstinState("29AAGCB7383J1Z4")?.name).toBe("Karnataka");
    expect(gstinState("29AAGCB7383J1Z5")).toBeNull();
  });

  test("table has Telangana and Ladakh", () => {
    expect(STATE_CODES["36"]).toBe("Telangana");
    expect(STATE_CODES["38"]).toBe("Ladakh");
  });
});

describe("GST rates", () => {
  test("known slabs only", () => {
    expect(GST_RATES).toContain("18");
    expect(isValidGstRate("0.25")).toBe(true);
    expect(isValidGstRate("7")).toBe(false);
  });
});
