import { normalizeProductName } from "../catalog/normalize";

/**
 * Links a bill line description to one of the business's stock items by name. Pure: no database.
 * A wrong link is worse than none, so it returns null unless one item clearly beats the rest.
 */
export type MatchableItem = { id: string; displayName: string; nameNorm: string };

/** Hindi (and common spelling variants) to the English name used in stock lists. */
const HINDI_TO_ENGLISH: Readonly<Record<string, string>> = {
  tamatar: "tomato",
  aloo: "potato",
  alu: "potato",
  pyaz: "onion",
  pyaj: "onion",
  kanda: "onion",
  bhindi: "okra",
  gobhi: "cauliflower",
  gobi: "cauliflower",
  baingan: "brinjal",
  baigan: "brinjal",
  mirch: "chilli",
  mirchi: "chilli",
  adrak: "ginger",
  lahsun: "garlic",
  lasan: "garlic",
  kela: "banana",
  aam: "mango",
  seb: "apple",
  santra: "orange",
  angoor: "grapes",
  kheera: "cucumber",
  gajar: "carrot",
  palak: "spinach",
  dhaniya: "coriander",
  pudina: "mint",
};

/** Words that mark the plain, everyday variety of an item: "Tomato (Desi)" is what "tomato" means. */
const DEFAULT_VARIANTS = new Set(["desi", "regular", "local", "normal"]);

const MIN_SCORE = 0.6;
const MIN_MARGIN = 0.1;
const EXACT_BONUS = 0.15;
const DEFAULT_BONUS = 0.15;

function stem(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("oes")) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokens(text: string, translate: boolean): string[] {
  return normalizeProductName(text)
    .split(" ")
    .filter(Boolean)
    .map((t) => stem(translate ? (HINDI_TO_ENGLISH[t] ?? t) : t));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / (a.size + b.size - both);
}

type Alias = { raw: Set<string>; translated: Set<string>; isBase: boolean };

function alias(text: string, isBase: boolean): Alias {
  return { raw: new Set(tokens(text, false)), translated: new Set(tokens(text, true)), isBase };
}

/** Everything one item can be called: full name, name without brackets, each bracket part, base + part. */
function aliasesOf(displayName: string): { aliases: Alias[]; isDefaultVariant: boolean } {
  const brackets = [...displayName.matchAll(/[([{]([^)\]}]*)[)\]}]/g)].map((m) => m[1] ?? "");
  const base = displayName.replace(/[([{][^)\]}]*[)\]}]/g, " ");
  const split = (s: string) =>
    s
      .split(/[,/]/)
      .map((p) => p.trim())
      .filter(Boolean);
  const bases = split(base);
  const parts = brackets.flatMap(split);
  const aliases = [alias(displayName, false)];
  for (const b of bases) aliases.push(alias(b, true));
  for (const p of parts) aliases.push(alias(p, false));
  const lead = bases[0];
  if (lead) for (const p of parts) aliases.push(alias(`${lead} ${p}`, false));
  const isDefaultVariant = parts.some((p) =>
    normalizeProductName(p)
      .split(" ")
      .every((t) => DEFAULT_VARIANTS.has(t)),
  );
  return { aliases, isDefaultVariant };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((t) => b.has(t));
}

function scoreItem(
  q: { raw: Set<string>; translated: Set<string> },
  aliases: Alias[],
  isDefaultVariant: boolean,
): number {
  let best = 0;
  for (const a of aliases) {
    let s = Math.max(jaccard(q.raw, a.raw), jaccard(q.translated, a.translated));
    if (s === 0) continue;
    if (sameSet(q.raw, a.raw)) s += EXACT_BONUS;
    if (a.isBase && isDefaultVariant && s >= 1) s += DEFAULT_BONUS;
    if (s > best) best = s;
  }
  return best;
}

export function matchMasterProduct<T extends MatchableItem>(
  description: string,
  items: readonly T[],
): T | null {
  const norm = normalizeProductName(description);
  if (norm === "" || items.length === 0) return null;

  const exact = items.find((i) => i.nameNorm === norm);
  if (exact) return exact;

  const q = { raw: new Set(tokens(norm, false)), translated: new Set(tokens(norm, true)) };
  let best: T | null = null;
  let bestScore = 0;
  let second = 0;
  for (const item of items) {
    const { aliases, isDefaultVariant } = aliasesOf(item.displayName);
    const score = scoreItem(q, aliases, isDefaultVariant);
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = item;
    } else if (score > second) {
      second = score;
    }
  }
  if (!best || bestScore < MIN_SCORE) return null;
  return bestScore - second >= MIN_MARGIN - 1e-9 ? best : null;
}
