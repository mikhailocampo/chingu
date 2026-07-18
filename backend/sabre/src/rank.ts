/**
 * Policy evaluation and option ranking.
 *
 * PURE. No I/O, no network, no clock access — `now` is always injected. This
 * module is the product thesis in code: `arrival_by` beats price. An option
 * that lands after the traveller is due on the ground is worthless no matter
 * how cheap, so it FAILs rather than merely warning.
 */

import type { EventWindow, Offer, Policy, PolicyVerdict, RankedOffer } from "./types.ts";

/** How many options the voice agent will ever read out. */
const MAX_RANKED = 3;

// ------------------------------------------------------------------- money

const DECIMAL = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a decimal money string to integer cents.
 *
 * Money crosses the wire as a string and must never round-trip through a
 * float — `0.1 + 0.2` problems become silent budget-gate errors. Returns null
 * for anything unparseable, including null/undefined.
 *
 * Sabre is inconsistent about formatting: change fees come back as both
 * `"0"` and `"0.00"` in the same response, so both must parse.
 */
export function toCents(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const m = DECIMAL.exec(value.trim());
  if (!m) return null;
  const [, sign, whole, frac] = m;
  const cents = Number(whole) * 100 + Number((frac ?? "").padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}

// ------------------------------------------------------------------ expiry

/**
 * Is this offer dead as of `now`?
 *
 * Flight offers live ~20 minutes (`validUntil`); hotel `bookingKey`s only ~7.
 * `now` is a parameter and never `Date.now()` so this is testable and so a
 * whole triage pass can be evaluated against one consistent instant.
 *
 * An offer with no expiry is treated as live — absence of a deadline is not
 * evidence of one.
 */
export function isExpired(offer: Pick<Offer, "expiresAt">, now: Date): boolean {
  if (!offer.expiresAt) return false;
  const expiry = Date.parse(offer.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return now.getTime() > expiry;
}

// ------------------------------------------------------------- evaluation

interface Verdict {
  verdict: PolicyVerdict;
  reason: string;
}

function evaluate(offer: Offer, policy: Policy, event: EventWindow): Verdict {
  // 1. Arrival window first. This is the whole point of the product: an
  //    option that misses the event is not a cheaper option, it is not an
  //    option. Checked before price so the reason surfaced to a human is the
  //    one that actually matters.
  if (event.arrival_by && offer.arrivesAt) {
    const due = Date.parse(event.arrival_by);
    const lands = Date.parse(offer.arrivesAt);
    if (!Number.isNaN(due) && !Number.isNaN(lands) && lands > due) {
      return {
        verdict: "FAIL",
        reason: `Arrives ${offer.arrivesAt}, after the required arrival of ${event.arrival_by}.`,
      };
    }
  }

  const total = toCents(offer.totalDelta);

  // 2. An unpriced option cannot be auto-approved, but it is not a failure
  //    either — a human can still look at it. Distinct from a real $0.00 EVEN.
  if (total === null) {
    return {
      verdict: "NEEDS_APPROVAL",
      reason: "Price difference is unknown; cannot evaluate against policy automatically.",
    };
  }

  // 3. Hard ceiling.
  const ceiling = toCents(policy.max_add_collect);
  if (ceiling !== null && total > ceiling) {
    return {
      verdict: "FAIL",
      reason: `Add collect ${offer.totalDelta} exceeds the policy maximum of ${policy.max_add_collect}.`,
    };
  }

  // 4. Approval gate.
  const gate = toCents(policy.requires_approval_over);
  if (gate !== null && total > gate) {
    return {
      verdict: "NEEDS_APPROVAL",
      reason: `Add collect ${offer.totalDelta} is over the ${policy.requires_approval_over} approval threshold.`,
    };
  }

  // 5. Clean.
  if (total < 0) {
    return { verdict: "PASS", reason: `Refund of ${offer.totalDelta}; within policy.` };
  }
  return { verdict: "PASS", reason: `Add collect ${offer.totalDelta} is within policy.` };
}

// ---------------------------------------------------------------- ordering

const VERDICT_ORDER: Record<PolicyVerdict, number> = {
  PASS: 0,
  NEEDS_APPROVAL: 1,
  FAIL: 2,
};

/** Nulls sort last so a priced option always beats an unpriced one. */
function nullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function arrivalMs(offer: Offer): number | null {
  if (!offer.arrivesAt) return null;
  const t = Date.parse(offer.arrivesAt);
  return Number.isNaN(t) ? null : t;
}

// ------------------------------------------------------------------- rank

/**
 * Evaluate every offer against policy and return the best `MAX_RANKED`.
 *
 * Expired offers are dropped outright rather than ranked-and-failed: they are
 * not actionable, and surfacing a dead offer to a traveller on a phone call
 * wastes the call. Everything else is returned with its verdict so a human can
 * still approve something that merely needs approval.
 *
 * Ordering: verdict (PASS, then NEEDS_APPROVAL, then FAIL), then cheapest,
 * then earliest arrival, then offer id for stability.
 *
 * Pure: the input array is never mutated.
 */
export function rankOffers(
  offers: Offer[],
  policy: Policy,
  event: EventWindow,
  now: Date,
): RankedOffer[] {
  return offers
    .filter((o) => !isExpired(o, now))
    .map((o): RankedOffer => {
      const { verdict, reason } = evaluate(o, policy, event);
      return { ...o, rank: 0, policyVerdict: verdict, policyReason: reason };
    })
    .sort((a, b) => {
      const byVerdict = VERDICT_ORDER[a.policyVerdict] - VERDICT_ORDER[b.policyVerdict];
      if (byVerdict !== 0) return byVerdict;

      const byPrice = nullsLast(toCents(a.totalDelta), toCents(b.totalDelta));
      if (byPrice !== 0) return byPrice;

      const byArrival = nullsLast(arrivalMs(a), arrivalMs(b));
      if (byArrival !== 0) return byArrival;

      return a.providerOfferId.localeCompare(b.providerOfferId);
    })
    .slice(0, MAX_RANKED)
    .map((o, i) => ({ ...o, rank: i + 1 }));
}
