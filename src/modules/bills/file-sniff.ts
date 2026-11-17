export type SniffedFile = { mime: string; ext: string };

const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to));
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "heif",
]);

/** Identifies a bill upload by its leading bytes (never by file name or declared type). Null when unsupported. */
export function sniffFile(b: Uint8Array): SniffedFile | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    b.length >= 8 &&
    ascii(b, 1, 4) === "PNG" &&
    b[0] === 0x89 &&
    b[4] === 0x0d &&
    b[5] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(b, 8, 12))) {
    return { mime: "image/heic", ext: "heic" };
  }
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  return null;
}
