import type { AiHints } from "../../../platform/ai/provider";

// v2: unit is what the rate applies to, container counts in package_count/package_unit, deductions.
// v3: seller and buyer are both read; our business (GSTIN, name or alias) is never the counterparty.
export const PROMPT_VERSION = "v3";

/** Instruction text for the bill reader (AI_EXTRACTION section 2). */
export function buildPrompt(h: AiHints): string {
  const side = h.billType === "purchase" ? "seller" : "buyer";
  const aliases = (h.ownAliases ?? []).filter((a) => a.trim() !== "");
  const also =
    aliases.length > 0 ? `, also written as ${aliases.map((a) => `"${a}"`).join(", ")}` : "";
  const own = `${h.ownName}${also}${h.ownGstin ? ` (GSTIN ${h.ownGstin})` : ""}`;
  return [
    "You are reading an Indian business bill or receipt. It may be printed, a thermal receipt or handwritten, in English, Hindi or another Indian script. The attached files are the pages of ONE bill, in order.",
    `Our business is ${own}. The user says this is a ${h.billType.toUpperCase()}, so the counterparty is normally the ${side}. Return the counterparty, never our business.`,
    'Parties: read BOTH sides of the invoice. seller is the party that issued it (name and GSTIN in the header, "From", "Sold by", "Supplier"); buyer is the party it is billed to ("Bill to", "Buyer", "Customer", "Ship to", "M/s"). Fill seller and buyer with the name and GSTIN exactly as printed, even when one of them is our business; use null for a side that is not on the paper. counterparty is whichever of the two is NOT our business.',
    "Transcribe values exactly as written. Do not correct arithmetic and do not compute missing values. Use null when a value is absent or unreadable.",
    'Return numbers as plain decimal strings without currency symbols or thousand separators (for example "1250.50").',
    "Dates: return the date as written (date_raw) and your ISO interpretation (date_iso, YYYY-MM-DD), assuming the Indian day/month/year order.",
    "List the field names you are not confident about (smudged, overwritten, ambiguous digits) in uncertain_fields for a line item, or set the matching *_uncertain flag.",
    "If the image is not a bill or invoice, set is_bill to false.",
    "If the file contains more than one separate invoice, set multiple_invoices to true and extract only the first.",
    "Product names: keep them as written; do not translate or expand them.",
    "Mandi Dual Quantity: In Indian produce, mandi and commodity bills an item line may show BOTH a container count (e.g. '4 BOX', '5 bori', '10 crates', '4 nag', '2 peti') AND a quantity (e.g. '150' or '150 kg', or '90' packets) next to a rate (e.g. 'x 45') and a total (e.g. '= 6750'). The quantity is the number that, multiplied by the rate, gives the printed line amount (150 x 45 = 6750). unit is what the RATE applies to: kg when the rate is per kg, pcs when it is per piece or packet (e.g. 90 packets of baby corn at 90 each = 8100 is quantity 90, unit pcs). Never force kg. Put the container count in package_count and its kind in package_unit (box, crate, bori, peti, nag, bag), for example package_count '4', package_unit 'box'; do not put it in the description and never use it as quantity when the rate applies to the weight or pieces. Leave package_count null when no container count is written.",
    "Fees, Charges & Surcharges: Look for ancillary charges written below items, in totals, or in margins. Always extract them into other_charges with clear labels. Common Indian examples include: Station charge / Stn chg, Packaging / Bardana / Peti / Crate / Box charge, Hamali / Coolie / Labour / Loading-Unloading, Kanta / Tol / Weighment fees, Mandi Tax / Mandi Cess / Market fee, Gaadi bhada / Freight, Commission / Arhat. Never ignore these charges, as they are essential to reconcile with grand_total.",
    "Deductions from an earlier bill: lines written after the items or near the total that start with Less / Minus / Kam / Ghata / वापसी / Return and name an item with a quantity, rate or amount (e.g. 'Less Broccoli 27 x 70 = 1890') are goods credited back for an earlier bill. Put each in deductions with its description (the item), quantity, unit, rate and amount as positive numbers. They are NEVER a discount: do not add them to discount_total and do not list them in line_items. discount_total is only a discount written as such (Discount / Disc / Chhoot / Kasar) without an item.",
    "Put freight, packing, station charges, and similar extra charges in other_charges with their label. Put the amount printed in the line's amount column in amount, and the taxable value column (if any) in taxable_value.",
  ].join("\n");
}
