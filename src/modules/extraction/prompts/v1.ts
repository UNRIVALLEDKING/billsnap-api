import type { AiHints } from "../../../platform/ai/provider";

export const PROMPT_VERSION = "v1";

/** Instruction text for the bill reader (AI_EXTRACTION section 2). */
export function buildPrompt(h: AiHints): string {
  const side = h.billType === "purchase" ? "seller" : "buyer";
  const own = h.ownGstin ? `${h.ownName} (GSTIN ${h.ownGstin})` : h.ownName;
  return [
    "You are reading an Indian business bill or receipt. It may be printed, a thermal receipt or handwritten, in English, Hindi or another Indian script. The attached files are the pages of ONE bill, in order.",
    `Our business is ${own}. The user says this is a ${h.billType.toUpperCase()}, so the counterparty is the ${side}. Return the counterparty, not our business.`,
    "Transcribe values exactly as written. Do not correct arithmetic and do not compute missing values. Use null when a value is absent or unreadable.",
    'Return numbers as plain decimal strings without currency symbols or thousand separators (for example "1250.50").',
    "Dates: return the date as written (date_raw) and your ISO interpretation (date_iso, YYYY-MM-DD), assuming the Indian day/month/year order.",
    "List the field names you are not confident about (smudged, overwritten, ambiguous digits) in uncertain_fields for a line item, or set the matching *_uncertain flag.",
    "If the image is not a bill or invoice, set is_bill to false.",
    "If the file contains more than one separate invoice, set multiple_invoices to true and extract only the first.",
    "Product names: keep them as written; do not translate or expand them.",
    "Mandi Dual Quantity: In Indian produce, mandi, and commodity bills, an item line may contain BOTH a packaging/container count (e.g. '3 boxes', '5 bori', '10 crates', '4 nag') AND a net weight or quantity (e.g. '115' or '115 kg') next to a rate (e.g. 'x 50') and total (e.g. '= 5750'). The billable quantity is the number that, when multiplied by rate, equals the printed line amount (e.g. 115 * 50 = 5750). Set quantity to 115, unit to kg, rate to 50, and keep the container count in description (e.g. 'Cucumber (3 boxes)'). Never set quantity to the container count when the rate applies to weight.",
    "Fees, Charges & Surcharges: Look for ancillary charges written below items, in totals, or in margins. Always extract them into other_charges with clear labels. Common Indian examples include: Station charge / Stn chg, Packaging / Bardana / Peti / Crate / Box charge, Hamali / Coolie / Labour / Loading-Unloading, Kanta / Tol / Weighment fees, Mandi Tax / Mandi Cess / Market fee, Gaadi bhada / Freight, Commission / Arhat. Never ignore these charges, as they are essential to reconcile with grand_total.",
    "Put freight, packing, station charges, and similar extra charges in other_charges with their label. Put the amount printed in the line's amount column in amount, and the taxable value column (if any) in taxable_value.",
  ].join("\n");
}
