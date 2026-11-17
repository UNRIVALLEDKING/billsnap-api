const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 2 state digits, 10-char PAN, entity number, literal Z, checksum. */
const GSTIN_SHAPE = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** GST slabs (percent). Slabs change, so keep them in one place; AI_EXTRACTION `gst_rate_invalid` uses this. */
export const GST_RATES = ["0", "0.1", "0.25", "1.5", "3", "5", "12", "18", "28", "40"] as const;

export const STATE_CODES: Readonly<Record<string, string>> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

/** Mod-36 check character for the first 14 characters of a GSTIN. */
export function gstinCheckChar(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(first14.charAt(i));
    if (value < 0) throw new TypeError("invalid GSTIN character");
    const product = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET.charAt((36 - (total % 36)) % 36);
}

/** True when shape, state code and checksum are all valid. Input must already be upper-case. */
export function isValidGstin(gstin: string): boolean {
  const m = GSTIN_SHAPE.exec(gstin);
  if (!m || !Object.hasOwn(STATE_CODES, m[1] as string)) return false;
  return gstinCheckChar(gstin.slice(0, 14)) === gstin.charAt(14);
}

export function gstinState(gstin: string): { code: string; name: string } | null {
  if (!isValidGstin(gstin)) return null;
  const code = gstin.slice(0, 2);
  return { code, name: STATE_CODES[code] as string };
}

export function isValidGstRate(rate: string): boolean {
  return (GST_RATES as readonly string[]).includes(rate);
}
