export type StandardFee = {
  name: string;
  category: "transport" | "hamali" | "packaging" | "cess" | "other";
  defaultBasis: "weight" | "value";
};

export const STANDARD_FEES: StandardFee[] = [
  {
    name: "Transport / Tempo",
    category: "transport",
    defaultBasis: "weight",
  },
  {
    name: "Hamali / Loading & Unloading",
    category: "hamali",
    defaultBasis: "weight",
  },
  {
    name: "Ice Box Packaging",
    category: "packaging",
    defaultBasis: "weight",
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
