/** UUIDv7: time-ordered, so primary keys index well and sort by creation time. */
export function newId(): string {
  return Bun.randomUUIDv7();
}
