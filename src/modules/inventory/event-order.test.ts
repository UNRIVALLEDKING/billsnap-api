import { describe, expect, test } from "bun:test";
import { compareEvents, type EventKey, istDate, sortEvents } from "./event-order";

const ev = (id: string, on: string, rank: 0 | 1, at: string): EventKey => ({
  id,
  on,
  rank,
  at: new Date(at),
});

describe("istDate", () => {
  test("uses the India calendar day", () => {
    expect(istDate(new Date("2026-02-09T18:29:59Z"))).toBe("2026-02-09");
    expect(istDate(new Date("2026-02-09T18:30:00Z"))).toBe("2026-02-10");
    expect(istDate(new Date("2026-02-10T18:29:59.999Z"))).toBe("2026-02-10");
  });
});

describe("event order", () => {
  test("bill date wins over confirm order: a sale dated 16 Nov comes before an 18 Nov purchase", () => {
    const purchase = ev("p", "2026-11-18", 0, "2026-11-18T05:00:00Z");
    const sale = ev("s", "2026-11-16", 1, "2026-11-19T05:00:00Z");
    expect(sortEvents([purchase, sale]).map((e) => e.id)).toEqual(["s", "p"]);
  });

  test("same day: purchases first, then the rest by creation time, then id", () => {
    const day = "2026-11-18";
    const events = [
      ev("sale-late", day, 1, "2026-11-18T10:00:00Z"),
      ev("waste", day, 1, "2026-11-18T06:00:00Z"),
      ev("buy-late", day, 0, "2026-11-18T12:00:00Z"),
      ev("buy-b", day, 0, "2026-11-18T04:00:00Z"),
      ev("buy-a", day, 0, "2026-11-18T04:00:00Z"),
      ev("earlier-day", "2026-11-17", 1, "2026-11-19T00:00:00Z"),
    ];
    expect(sortEvents(events).map((e) => e.id)).toEqual([
      "earlier-day",
      "buy-a",
      "buy-b",
      "buy-late",
      "waste",
      "sale-late",
    ]);
  });

  test("is a total order and does not mutate its input", () => {
    const a = ev("a", "2026-11-18", 1, "2026-11-18T04:00:00Z");
    const input = [a, ev("b", "2026-11-17", 1, "2026-11-18T04:00:00Z")];
    const sorted = sortEvents(input);
    expect(input[0]?.id).toBe("a");
    expect(sorted.map((e) => e.id)).toEqual(["b", "a"]);
    expect(compareEvents(a, { ...a })).toBe(0);
  });
});
