/** Indian financial year (April 1 to March 31), labelled like "2025-26". Dates are "YYYY-MM-DD" strings. */
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const FY = /^(\d{4})-(\d{2})$/;

export function fyOf(date: string): string {
  const m = DATE.exec(date);
  if (!m) throw new TypeError(`invalid date: "${date}"`);
  const year = Number(m[1]);
  const start = Number(m[2]) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function fyRange(fy: string): { from: string; to: string } {
  const m = FY.exec(fy);
  const start = m ? Number(m[1]) : Number.NaN;
  if (!m || Number(m[2]) !== (start + 1) % 100) {
    throw new TypeError(`invalid financial year: "${fy}"`);
  }
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}
