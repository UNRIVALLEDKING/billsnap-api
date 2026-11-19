/**
 * Rebuilds the stock of every item from its bills and manual movements, in bill-date order
 * (docs/BILL_ACCURACY_PLAN.md section 2). Repairs stock that moved in confirm order before the replay
 * engine existed. Safe to re-run: a second run rewrites the same rows and re-costs no sale.
 *
 *   bun run replay                  every business
 *   bun run replay <business-id>    one business
 *
 * In Docker:  docker compose -f compose.dev.yml --profile full exec api bun run replay
 * Uses DATABASE_URL.
 *
 * An item whose confirmed bills use a unit it has no factor for is skipped and listed; save the factor
 * (PUT /v1/inventory/master-products/:id/units/:unit) and run again.
 */
import { asc, eq } from "drizzle-orm";
import { businesses } from "../modules/businesses/businesses.schema";
import { lockCatalog } from "../modules/catalog/catalog.service";
import { masterProducts } from "../modules/inventory/inventory.schema";
import type { UnitConversionLine } from "../modules/inventory/inventory.service";
import { replayItems } from "../modules/inventory/replay";
import { createDatabase } from "../platform/db/client";
import { AppError } from "../platform/errors";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const only = process.argv[2];

const database = createDatabase({ url, poolSize: 2 });
const totals = { businesses: 0, items: 0, events: 0, salesRecosted: 0 };

try {
  const list = await database.db
    .select({ id: businesses.id, name: businesses.name })
    .from(businesses)
    .where(only ? eq(businesses.id, only) : undefined)
    .orderBy(asc(businesses.id));
  if (only && list.length === 0) throw new Error(`business ${only} not found`);

  for (const biz of list) {
    // One transaction per business, holding the same lock confirm and edit take.
    const r = await database.tx(async ({ db }) => {
      await lockCatalog(db, biz.id);
      const items = await db
        .select({ id: masterProducts.id })
        .from(masterProducts)
        .where(eq(masterProducts.businessId, biz.id));
      let ids = items.map((i) => i.id);
      const skipped: UnitConversionLine[] = [];
      for (;;) {
        try {
          return { ...(await replayItems(db, biz.id, ids)), skipped };
        } catch (err) {
          // Checked before anything is rebuilt, so the other items can still go.
          if (!(err instanceof AppError && err.code === "unit_conversion_needed")) throw err;
          const stuck = err.fields.lines as UnitConversionLine[];
          const bad = new Set(stuck.map((l) => l.item_id));
          skipped.push(...stuck);
          ids = ids.filter((id) => !bad.has(id));
        }
      }
    });
    for (const s of r.skipped) {
      console.log(
        `  skipped ${s.item_name} (${s.item_id}): no factor from ${s.from_unit} to ${s.to_unit} (bill ${s.bill_id})`,
      );
    }
    totals.businesses++;
    totals.items += r.items;
    totals.events += r.events;
    totals.salesRecosted += r.salesRecosted;
    console.log(
      `${biz.name} (${biz.id}): ${r.items} items, ${r.events} movements, ${r.salesRecosted} sale lines re-costed`,
    );
  }
  console.log(
    `replayed ${totals.businesses} businesses: ${totals.items} items, ${totals.events} movements, ${totals.salesRecosted} sale lines re-costed`,
  );
} catch (err) {
  console.error("replay failed:", err);
  process.exitCode = 1;
} finally {
  await database.close();
}
