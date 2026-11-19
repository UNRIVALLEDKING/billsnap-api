export type StandardFee = {
  name: string;
  category: "transport" | "hamali" | "packaging" | "cess" | "other";
  /** Station charge, ice box and hamali by boxes; freight by weight; mandi cess by value. */
  defaultBasis: "weight" | "value" | "packs";
};

export const STANDARD_FEES: StandardFee[] = [
  {
    name: "Transport / Tempo",
    category: "transport",
    defaultBasis: "weight",
  },
  {
    name: "Station charge",
    category: "transport",
    defaultBasis: "packs",
  },
  {
    name: "Hamali / Loading & Unloading",
    category: "hamali",
    defaultBasis: "packs",
  },
  {
    name: "Ice Box Packaging",
    category: "packaging",
    defaultBasis: "packs",
  },
  {
    name: "Wooden Crate Packaging",
    category: "packaging",
    defaultBasis: "value",
  },
  {
    name: "APMC / Mandi Cess",
    category: "cess",
    defaultBasis: "value",
  },
];
