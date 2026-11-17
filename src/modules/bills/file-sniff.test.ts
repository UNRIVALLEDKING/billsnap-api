import { describe, expect, test } from "bun:test";
import { sniffFile } from "./file-sniff";

const bytes = (...v: Array<number | string>) =>
  Uint8Array.from(
    v.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])),
  );

describe("sniffFile", () => {
  test("detects each supported type", () => {
    expect(sniffFile(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))?.mime).toBe("image/jpeg");
    expect(sniffFile(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a))?.mime).toBe("image/png");
    expect(sniffFile(bytes("RIFF", 1, 2, 3, 4, "WEBPVP8 "))?.mime).toBe("image/webp");
    expect(sniffFile(bytes(0, 0, 0, 24, "ftypheic", 0, 0))?.mime).toBe("image/heic");
    expect(sniffFile(bytes(0, 0, 0, 24, "ftypmif1", 0, 0))?.ext).toBe("heic");
    expect(sniffFile(bytes("%PDF-1.7\n"))).toEqual({ mime: "application/pdf", ext: "pdf" });
  });

  test("rejects everything else", () => {
    expect(sniffFile(bytes())).toBeNull();
    expect(sniffFile(bytes("GIF89a"))).toBeNull();
    expect(sniffFile(bytes("<html></html>"))).toBeNull();
    expect(sniffFile(bytes("RIFF", 1, 2, 3, 4, "WAVEfmt "))).toBeNull();
    expect(sniffFile(bytes(0, 0, 0, 24, "ftypmp42", 0, 0))).toBeNull();
    expect(sniffFile(bytes(0xff, 0xd8))).toBeNull();
  });
});
