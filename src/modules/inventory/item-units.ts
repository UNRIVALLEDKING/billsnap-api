import Decimal from "decimal.js";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Executor } from "../../platform/db/client";
import { AppError, notFound } from "../../platform/errors";
import { newId } from "../../shared/ids";
import { dec, fmt } from "../../shared/money";
import { billLineItems, bills } from "../bills/bills.schema";
import { inventoryTransactions, itemUnits, masterProducts } from "./inventory.schema";
import { replayItems } from "./replay";
import {
  builtinFactor,
  type ItemUnitFactor,
  normalizeUnit,
  STORED_SOURCES,
  stockFactor,
} from "./units";

/**
 * An item's own units and pack sizes, and changing the unit it is counted in
 * (docs/BILL_ACCURACY_PLAN.md section 3). Every change replays the item, so stock already received in
 * that unit is re-counted with the new factor.
 */

const PER_UNIT_DP = 6;

async function lockItem(db: Executor, businessId: string, id: string) {
  const [prod] = await db
    .select({
      id: masterProducts.id,
      displayName: masterProducts.displayName,
      standardUnit: masterProducts.standardUnit,
      reorderLevel: masterProducts.reorderLevel,
    })
    .from(masterProducts)
    .where(and(eq(masterProducts.businessId, businessId), eq(masterProducts.id, id)))
    .for("update");
  if (!prod) throw notFound("master_product");
  return prod;
}

const ownUnits = (db: Executor, id: string) =>
  db.select().from(itemUnits).where(eq(itemUnits.masterProductId, id));

/** Creates or replaces the item's factor for `unit` (as entered by the user), then replays the item. */
export async function setItemUnit(
  db: Executor,
  businessId: string,
  masterProductId: string,
  unitRaw: string,
  input: { perUnit: string; approx: boolean },
): Promise<void> {
  const prod = await lockItem(db, businessId, masterProductId);
  const unit = normalizeUnit(unitRaw);
  const builtin = builtinFactor(unit, prod.standardUnit);
  if (builtin) {
    throw new AppError(
      "unit_builtin",
      422,
      `1 ${unit} is always ${builtin.toFixed()} ${prod.standardUnit}; no factor is needed`,
    );
  }
  const perUnit = fmt(input.perUnit, PER_UNIT_DP);
  await db
    .insert(itemUnits)
    .values({
      id: newId(),
      businessId,
      masterProductId,
      unit,
      perUnit,
      approx: input.approx,
      source: "user",
    })
    .onConflictDoUpdate({
      target: [itemUnits.masterProductId, itemUnits.unit],
      set: { perUnit, approx: input.approx, source: "user" },
    });
  await replayItems(db, businessId, [masterProductId]);
}

/** Removes the item's factor for `unit`; 409 `unit_in_use` while confirmed bills still need it. */
export async function deleteItemUnit(
  db: Executor,
  businessId: string,
  masterProductId: string,
  unitRaw: string,
): Promise<void> {
  await lockItem(db, businessId, masterProductId);
  const unit = normalizeUnit(unitRaw);
  const gone = await db
    .delete(itemUnits)
    .where(and(eq(itemUnits.masterProductId, masterProductId), eq(itemUnits.unit, unit)))
    .returning({ id: itemUnits.id });
  if (gone.length === 0) throw notFound("item_unit");
  try {
    await replayItems(db, businessId, [masterProductId]);
  } catch (err) {
    if (err instanceof AppError && err.code === "unit_conversion_needed") {
      throw new AppError(
        "unit_in_use",
        409,
        `Confirmed bills count this item in ${unit}; the factor is still needed`,
        {},
        { units: [unit] },
      );
    }
    throw err;
  }
}

/**
 * Learns pack sizes from a confirmed purchase line that has a pack count and a quantity in a unit the
 * item converts from: 4 box and 150 kg of cucumber (counted in kg) gives box -> 37.5. Saved as
 * 'suggested' and approximate; a 'user' row is never replaced.
 */
export async function learnPackSizes(
  db: Executor,
  businessId: string,
  lines: Array<{
    masterProductId: string | null;
    quantity: string;
    unit: string;
    packCount: string | null;
    packUnit: string | null;
  }>,
): Promise<void> {
  for (const l of lines) {
    if (!l.masterProductId || !l.packUnit || l.packCount == null) continue;
    const packs = dec(l.packCount);
    const qty = dec(l.quantity);
    if (!packs.gt(0) || !qty.gt(0)) continue;
    const [prod] = await db
      .select({ standardUnit: masterProducts.standardUnit })
      .from(masterProducts)
      .where(
        and(eq(masterProducts.businessId, businessId), eq(masterProducts.id, l.masterProductId)),
      )
      .limit(1);
    if (!prod) continue;
    const packUnit = normalizeUnit(l.packUnit);
    if (packUnit === normalizeUnit(l.unit) || builtinFactor(packUnit, prod.standardUnit)) continue;
    const own = await ownUnits(db, l.masterProductId);
    if (own.some((r) => r.unit === packUnit && r.source === "user")) continue;
    const factor = stockFactor(
      l.unit,
      prod.standardUnit,
      own.filter((r) => r.unit !== packUnit),
    );
    if (!factor) continue;
    const perUnit = fmt(qty.mul(factor).div(packs), PER_UNIT_DP);
    if (!dec(perUnit).gt(0)) continue;
    await db
      .insert(itemUnits)
      .values({
        id: newId(),
        businessId,
        masterProductId: l.masterProductId,
        unit: packUnit,
        perUnit,
        approx: true,
        source: "suggested",
      })
      .onConflictDoUpdate({
        target: [itemUnits.masterProductId, itemUnits.unit],
        set: { perUnit, approx: true },
        setWhere: eq(itemUnits.source, "suggested"),
      });
  }
}

/**
 * Changes the unit an item is counted in. Allowed when every movement converts to the new unit:
 * bill lines by the conversion rule, manual movements (stored in the old unit) through the old unit.
 * The item's own factors are re-expressed in the new unit, then the item is replayed. Otherwise 409
 * `unit_locked`, with `units` naming what can't be converted.
 */
export async function changeStandardUnit(
  db: Executor,
  businessId: string,
  masterProductId: string,
  unitRaw: string,
): Promise<void> {
  const prod = await lockItem(db, businessId, masterProductId);
  const from = prod.standardUnit;
  const to = normalizeUnit(unitRaw);
  if (to === from) return;

  const own = await ownUnits(db, masterProductId);
  const factors: ItemUnitFactor[] = own.map((r) => ({ unit: r.unit, perUnit: r.perUnit }));
  /** Old units in 1 new unit, when known. */
  const f = stockFactor(to, from, factors);
  const toNew = (u: string): Decimal | null => {
    const direct = builtinFactor(u, to);
    if (direct) return direct;
    const old = f ? stockFactor(u, from, factors) : null;
    return old && f ? old.div(f) : null;
  };

  const lineUnits = await db
    .selectDistinct({
      unit: billLineItems.unit,
      stored: sql<boolean>`${billLineItems.stockFactor} is not null and ${billLineItems.stockFactorSource} in ('customer', 'manual')`,
    })
    .from(billLineItems)
    .innerJoin(bills, eq(billLineItems.billId, bills.id))
    .where(
      and(
        eq(billLineItems.businessId, businessId),
        eq(billLineItems.masterProductId, masterProductId),
        eq(bills.status, "confirmed"),
      ),
    );
  const [manual] = await db
    .select({ id: inventoryTransactions.id })
    .from(inventoryTransactions)
    .where(
      and(
        eq(inventoryTransactions.masterProductId, masterProductId),
        isNull(inventoryTransactions.billId),
      ),
    )
    .limit(1);

  const stuck = new Set<string>();
  if (manual && !f) stuck.add(from);
  // A factor kept on a line (a party spec or review choice) is rescaled, which needs the old-to-new factor.
  for (const { unit, stored } of lineUnits) {
    if (stored ? !f : !toNew(unit)) stuck.add(normalizeUnit(unit));
  }
  if (stuck.size > 0) {
    const names = [...stuck].sort();
    throw new AppError(
      "unit_locked",
      409,
      `Can't count ${prod.displayName} in ${to}: no factor from ${names.join(", ")}`,
      {},
      { units: names },
    );
  }

  // Factors were "old units per 1 unit"; now they are "new units per 1 unit".
  await db.delete(itemUnits).where(eq(itemUnits.masterProductId, masterProductId));
  if (f) {
    const keep = own.filter((r) => r.unit !== to && !builtinFactor(r.unit, to));
    const rows = keep.map((r) => ({
      ...r,
      perUnit: fmt(dec(r.perUnit).div(f), PER_UNIT_DP),
    }));
    if (!builtinFactor(from, to)) {
      // The old unit becomes one of the item's units, as exact as the factor it came from.
      const source =
        own.find((r) => r.unit === to) ?? own.find((r) => builtinFactor(to, r.unit) !== null);
      rows.push({
        id: newId(),
        businessId,
        masterProductId,
        unit: from,
        perUnit: fmt(new Decimal(1).div(f), PER_UNIT_DP),
        approx: source?.approx ?? false,
        source: source?.source ?? "user",
        createdAt: new Date(),
      });
    }
    if (rows.length > 0) await db.insert(itemUnits).values(rows);
  }

  await db
    .update(masterProducts)
    .set({
      standardUnit: to,
      reorderLevel:
        prod.reorderLevel == null || !f ? prod.reorderLevel : fmt(dec(prod.reorderLevel).div(f), 3),
      updatedAt: new Date(),
    })
    .where(eq(masterProducts.id, masterProductId));

  if (f) {
    // Kept factors were "old units per 1 line unit"; now "new units per 1 line unit".
    await db
      .update(billLineItems)
      .set({ stockFactor: sql`round(${billLineItems.stockFactor} / ${f.toFixed()}::numeric, 6)` })
      .where(
        and(
          eq(billLineItems.businessId, businessId),
          eq(billLineItems.masterProductId, masterProductId),
          inArray(billLineItems.stockFactorSource, [...STORED_SOURCES]),
          isNotNull(billLineItems.stockFactor),
        ),
      );
  }

  // Manual movements are still stored in the old unit: replay converts them through it.
  await replayItems(db, businessId, [masterProductId], {
    manualUnits: new Map([[masterProductId, from]]),
  });
}
