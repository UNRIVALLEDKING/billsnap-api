import { z } from "zod";

// The AI output contract (AI_EXTRACTION section 3). Numbers arrive as strings, but a model may emit JSON
// numbers, so both are accepted and turned into strings for the money-safe normalizer.
const text = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null ? null : String(v)));
const flag = z
  .boolean()
  .nullish()
  .transform((v) => v === true);

const lineItem = z.object({
  description: text,
  hsn_sac: text,
  quantity: text,
  unit: text,
  rate: text,
  discount: text,
  taxable_value: text,
  gst_rate: text,
  cgst: text,
  sgst: text,
  igst: text,
  cess: text,
  amount: text,
  uncertain_fields: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
});

const emptyCounterparty = {
  name: null,
  name_uncertain: false,
  gstin: null,
  gstin_uncertain: false,
  state: null,
};

export const extractionOutput = z.object({
  is_bill: z.boolean(),
  multiple_invoices: flag,
  document_kind: text,
  counterparty: z
    .object({
      name: text,
      name_uncertain: flag,
      gstin: text,
      gstin_uncertain: flag,
      state: text,
    })
    .nullish()
    .transform((v) => v ?? emptyCounterparty),
  own_gstin_on_bill: text,
  invoice_number: text,
  invoice_number_uncertain: flag,
  date_raw: text,
  date_iso: text,
  date_uncertain: flag,
  place_of_supply: text,
  reverse_charge: flag,
  line_items: z
    .array(lineItem)
    .nullish()
    .transform((v) => v ?? []),
  subtotal: text,
  discount_total: text,
  taxable_total: text,
  cgst_total: text,
  sgst_total: text,
  igst_total: text,
  cess_total: text,
  other_charges: z
    .array(z.object({ label: text, amount: text, category: text.optional() }))
    .nullish()
    .transform((v) => v ?? []),
  round_off: text,
  grand_total: text,
  grand_total_uncertain: flag,
});

export type ExtractionOutput = z.infer<typeof extractionOutput>;
export type ExtractedLine = ExtractionOutput["line_items"][number];

// Gemini responseSchema (OpenAPI subset).
const str = { type: "STRING", nullable: true } as const;
const bool = { type: "BOOLEAN", nullable: true } as const;
const obj = (properties: Record<string, object>, required: string[] = []) => ({
  type: "OBJECT",
  properties,
  ...(required.length > 0 && { required }),
});

export const RESPONSE_SCHEMA = obj(
  {
    is_bill: { type: "BOOLEAN" },
    multiple_invoices: bool,
    document_kind: str,
    counterparty: {
      ...obj({ name: str, name_uncertain: bool, gstin: str, gstin_uncertain: bool, state: str }, [
        "name",
        "gstin",
      ]),
      nullable: true,
    },
    own_gstin_on_bill: str,
    invoice_number: str,
    invoice_number_uncertain: bool,
    date_raw: str,
    date_iso: str,
    date_uncertain: bool,
    place_of_supply: str,
    reverse_charge: bool,
    line_items: {
      type: "ARRAY",
      items: obj(
        {
          description: str,
          hsn_sac: str,
          quantity: str,
          unit: str,
          rate: str,
          discount: str,
          taxable_value: str,
          gst_rate: str,
          cgst: str,
          sgst: str,
          igst: str,
          cess: str,
          amount: str,
          uncertain_fields: { type: "ARRAY", items: { type: "STRING" } },
        },
        ["description", "quantity", "unit", "rate", "amount"],
      ),
    },
    subtotal: str,
    discount_total: str,
    taxable_total: str,
    cgst_total: str,
    sgst_total: str,
    igst_total: str,
    cess_total: str,
    other_charges: { type: "ARRAY", items: obj({ label: str, amount: str, category: str }) },
    round_off: str,
    grand_total: str,
    grand_total_uncertain: bool,
  },
  [
    "is_bill",
    "counterparty",
    "invoice_number",
    "date_raw",
    "date_iso",
    "line_items",
    "subtotal",
    "discount_total",
    "cgst_total",
    "sgst_total",
    "igst_total",
    "cess_total",
    "other_charges",
    "round_off",
    "grand_total",
  ],
);

/** Why a read claiming to be a bill is too empty to show for review, or null when it is usable. */
export function incompleteRead(o: ExtractionOutput): string | null {
  if (!o.is_bill) return null;
  const hasNumbers = o.line_items.some((l) => l.amount != null || l.rate != null);
  if (hasNumbers || o.grand_total != null) return null;
  return "no line has an amount or rate and grand_total is missing; read every row and the total";
}
