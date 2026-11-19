/**
 * Order in which stock movements are replayed (docs/BILL_ACCURACY_PLAN.md section 2). Pure, so the
 * replay engine and its tests agree on one rule.
 */

export type EventKey = {
  /** Effective day, YYYY-MM-DD: the bill date, or the IST day a manual movement was recorded. */
  on: string;
  /** 0 for stock that arrives at a cost (purchases, costed opening stock), 1 for everything else. */
  rank: 0 | 1;
  /** Creation time: the bill's upload time, or the manual movement's own time. */
  at: Date;
  /** Final tie-break: the bill line id, or the manual movement's id. */
  id: string;
};

const IST_OFFSET_MS = 330 * 60 * 1000;

/** The calendar day in India (UTC+05:30) of an instant, as YYYY-MM-DD. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** By day, then purchases before sales and other movements on that day, then creation time, then id. */
export function compareEvents(a: EventKey, b: EventKey): number {
  if (a.on !== b.on) return a.on < b.on ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  const t = a.at.getTime() - b.at.getTime();
  if (t !== 0) return t;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function sortEvents<T extends EventKey>(events: T[]): T[] {
  return [...events].sort(compareEvents);
}
