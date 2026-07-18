/**
 * Dietary needs, reduced to something safe to say to a restaurant.
 *
 * Telling a venue that a guest has an allergy discloses a health fact about a
 * real person, so `disclose_ok` gates every single need (DATA_MODEL.md, and the
 * dinner scenario in HACKATHON_CONTEXT.md). Two rules hold here by construction
 * rather than by care at the call site:
 *
 *  1. Nothing without `disclose_ok` is ever rendered. Needs that fail the gate
 *     are reduced to a bare count so the agent can still ask about
 *     accommodations in general and flag a human to follow up.
 *  2. **A name is never paired with a medical detail.** The query behind this
 *     does not select names at all, and `notes` ("anaphylaxis; carries epipen")
 *     is never spoken either — the phrasing is derived from `kind` + `severity`
 *     only. There is no code path from an employee's identity to a clinical
 *     detail, which is stronger than remembering not to join them.
 */

import { countWord } from "./speak";

export type Need = {
  kind?: unknown;
  severity?: unknown;
  notes?: unknown;
  disclose_ok?: unknown;
};

export type DietarySummary = {
  /** Speakable, name-free phrases — one per (kind, severity) group. */
  phrases: string[];
  /** How many needs the gate withheld. Count only; never what they were. */
  withheld: number;
  /** Whether any disclosable need is a severe allergy. */
  severe: boolean;
};

/** Diets, not allergens: rendered as "is vegetarian", not "has an allergy". */
const STYLES: Record<string, string> = {
  VEGETARIAN: "vegetarian",
  VEGAN: "vegan",
  PESCATARIAN: "pescatarian",
  HALAL: "halal",
  KOSHER: "kosher",
};

const ALLERGENS: Record<string, string> = {
  SHELLFISH: "shellfish", FISH: "fish", NUTS: "nut", TREE_NUTS: "tree nut",
  PEANUT: "peanut", PEANUTS: "peanut", GLUTEN: "gluten", WHEAT: "wheat",
  DAIRY: "dairy", LACTOSE: "lactose", EGG: "egg", EGGS: "egg",
  SOY: "soy", SESAME: "sesame",
};

/** Severity ordering: the things a kitchen must not get wrong come first. */
const RANK: Record<string, number> = {
  ALLERGY_SEVERE: 0, ALLERGY: 1, ALLERGY_MILD: 2, INTOLERANCE: 3, PREFERENCE: 4,
};

/**
 * `disclose_ok` is written as 1/0 by the seed but may arrive as a bool or a
 * string. Only affirmative values open the gate — anything unrecognised stays
 * shut, because the failure directions are not symmetric: withholding is a
 * slightly worse brief, disclosing is a privacy breach.
 */
function mayDisclose(raw: unknown): boolean {
  if (raw === true || raw === 1) return true;
  if (typeof raw === "string") {
    return ["1", "true", "yes", "y"].includes(raw.trim().toLowerCase());
  }
  return false;
}

/** Parse a `dietary_json` column. Malformed JSON yields nothing, never a throw. */
export function parseNeeds(raw: string | null): Need[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => n && typeof n === "object") : [];
  } catch {
    return [];
  }
}

export function summarise(rows: (string | null)[]): DietarySummary {
  const needs = rows.flatMap(parseNeeds);
  const withheld = needs.filter((n) => !mayDisclose(n.disclose_ok)).length;
  const open = needs.filter((n) => mayDisclose(n.disclose_ok));

  // Group identical (kind, severity) pairs so two shellfish allergies become
  // "two guests", not the same sentence twice.
  const groups = new Map<string, { kind: string; severity: string; n: number }>();
  for (const need of open) {
    const kind = String(need.kind ?? "").toUpperCase();
    const severity = String(need.severity ?? "").toUpperCase();
    if (!kind) continue;
    const key = `${kind}|${severity}`;
    const seen = groups.get(key);
    if (seen) seen.n += 1;
    else groups.set(key, { kind, severity, n: 1 });
  }

  const ordered = [...groups.values()].sort(
    (a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.kind.localeCompare(b.kind),
  );

  return {
    phrases: ordered.map(phrase),
    withheld,
    severe: ordered.some((g) => g.severity === "ALLERGY_SEVERE"),
  };
}

function phrase(g: { kind: string; severity: string; n: number }): string {
  const many = g.n !== 1;
  const who = `${countWord(g.n)} guest${many ? "s" : ""}`;
  const has = many ? "have" : "has";

  const style = STYLES[g.kind];
  if (style) return capitalise(`${who} ${many ? "are" : "is"} ${style}`);

  const noun = ALLERGENS[g.kind] ?? g.kind.toLowerCase().replace(/_/g, " ");
  switch (g.severity) {
    case "ALLERGY_SEVERE":
      return capitalise(`${who} ${has} a severe ${noun} allergy`);
    case "ALLERGY":
    case "ALLERGY_MILD":
      return capitalise(`${who} ${has} a ${noun} allergy`);
    case "INTOLERANCE":
      return capitalise(`${who} ${has} a ${noun} intolerance`);
    case "PREFERENCE":
      return capitalise(`${who} ${many ? "avoid" : "avoids"} ${noun}`);
    default:
      return capitalise(`${who} ${has} a ${noun} requirement`);
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
