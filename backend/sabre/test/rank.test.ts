import { describe, expect, test } from "bun:test";
import { isExpired, rankOffers } from "../src/rank.ts";
import type { EventWindow, Offer, Policy } from "../src/types.ts";

// ---------------------------------------------------------------- fixtures

/** The seeded policy from the brief. */
const POLICY: Policy = {
  id: "pol_1",
  version: 3,
  currency: "USD",
  requires_approval_over: "150.00",
  max_add_collect: "600.00",
};

/** Event dinner is 18:00Z on the 15th; they must be on the ground by then. */
const EVENT: EventWindow = { arrival_by: "2026-09-15T18:00:00Z" };

const NOW = new Date("2026-07-18T19:30:00Z");

function offer(over: Partial<Offer> & { providerOfferId: string }): Offer {
  return {
    kind: "FLIGHT",
    expiresAt: "2026-07-18T19:43:54Z", // 13 min after NOW — live
    chargeType: "ADD_COLLECT",
    currency: "USD",
    fareDelta: null,
    taxDelta: null,
    feeDelta: null,
    totalDelta: "0.00",
    routeSummary: "JFK to ICN",
    arrivesAt: "2026-09-15T17:50:00Z", // comfortably before arrival_by
    ...over,
  };
}

// ------------------------------------------------------- policy verdict table

describe("rankOffers — policy verdict", () => {
  // The real seeded numbers from the brief, plus both boundaries.
  const cases: Array<{ total: string; verdict: string; why: string }> = [
    { total: "0.00", verdict: "PASS", why: "$0.00 EVEN is real, not null" },
    { total: "100.00", verdict: "PASS", why: "under approval gate" },
    { total: "120.00", verdict: "PASS", why: "under approval gate" },
    { total: "150.00", verdict: "PASS", why: "EXACTLY at the gate — not over" },
    { total: "150.01", verdict: "NEEDS_APPROVAL", why: "one cent over the gate" },
    { total: "200.00", verdict: "NEEDS_APPROVAL", why: "over the gate" },
    { total: "299.00", verdict: "NEEDS_APPROVAL", why: "over the gate" },
    { total: "600.00", verdict: "NEEDS_APPROVAL", why: "EXACTLY at the ceiling" },
    { total: "600.01", verdict: "FAIL", why: "one cent over the ceiling" },
    { total: "-250.00", verdict: "PASS", why: "a REFUND is never over budget" },
  ];

  for (const c of cases) {
    test(`$${c.total} -> ${c.verdict} (${c.why})`, () => {
      const [ranked] = rankOffers([offer({ providerOfferId: "o1", totalDelta: c.total })], POLICY, EVENT, NOW);
      expect(ranked!.policyVerdict).toBe(c.verdict as never);
      expect(ranked!.policyReason).toBeTruthy();
    });
  }

  test("a $0.00 EVEN offer is distinguished from a null total", () => {
    const [even] = rankOffers([offer({ providerOfferId: "even", totalDelta: "0.00", chargeType: "EVEN" })], POLICY, EVENT, NOW);
    expect(even!.policyVerdict).toBe("PASS");
    expect(even!.chargeType).toBe("EVEN");

    const [unknown] = rankOffers([offer({ providerOfferId: "unk", totalDelta: null })], POLICY, EVENT, NOW);
    expect(unknown!.policyVerdict).toBe("NEEDS_APPROVAL");
    expect(unknown!.policyReason).toMatch(/unknown|unpriced/i);
  });

  test("a null policy ceiling does not FAIL everything", () => {
    const open: Policy = { currency: "USD", max_add_collect: null, requires_approval_over: null };
    const [ranked] = rankOffers([offer({ providerOfferId: "o1", totalDelta: "9999.00" })], open, EVENT, NOW);
    expect(ranked!.policyVerdict).toBe("PASS");
  });
});

// ------------------------------------------------------------ arrival window

describe("rankOffers — arrival window", () => {
  test("arriving after arrival_by FAILs even when it is free", () => {
    const [ranked] = rankOffers(
      [offer({ providerOfferId: "late", totalDelta: "0.00", arrivesAt: "2026-09-15T19:00:00Z" })],
      POLICY,
      EVENT,
      NOW,
    );
    expect(ranked!.policyVerdict).toBe("FAIL");
    expect(ranked!.policyReason).toMatch(/arriv/i);
  });

  test("arriving exactly at arrival_by still PASSes", () => {
    const [ranked] = rankOffers(
      [offer({ providerOfferId: "onthedot", totalDelta: "0.00", arrivesAt: "2026-09-15T18:00:00Z" })],
      POLICY,
      EVENT,
      NOW,
    );
    expect(ranked!.policyVerdict).toBe("PASS");
  });

  test("no arrival_by on the event means arrival cannot fail an offer", () => {
    const [ranked] = rankOffers(
      [offer({ providerOfferId: "late", totalDelta: "0.00", arrivesAt: "2027-01-01T00:00:00Z" })],
      POLICY,
      { arrival_by: null },
      NOW,
    );
    expect(ranked!.policyVerdict).toBe("PASS");
  });
});

// -------------------------------------------------------------- the thesis

describe("rankOffers — ordering", () => {
  test("THE PRODUCT THESIS: cheapest-but-arrives-late must NOT rank first", () => {
    const cheapLate = offer({
      providerOfferId: "cheap-late",
      totalDelta: "0.00",
      arrivesAt: "2026-09-15T21:10:00Z", // after the dinner
      routeSummary: "JFK to ICN via HKG",
    });
    const pricierOnTime = offer({
      providerOfferId: "pricier-ontime",
      totalDelta: "120.00",
      arrivesAt: "2026-09-15T17:50:00Z",
      routeSummary: "KE82 nonstop",
    });

    const ranked = rankOffers([cheapLate, pricierOnTime], POLICY, EVENT, NOW);

    expect(ranked[0]!.providerOfferId).toBe("pricier-ontime");
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.policyVerdict).toBe("PASS");
    expect(ranked[1]!.providerOfferId).toBe("cheap-late");
    expect(ranked[1]!.policyVerdict).toBe("FAIL");
  });

  test("PASS sorts before NEEDS_APPROVAL even when NEEDS_APPROVAL is cheaper", () => {
    const ranked = rankOffers(
      [
        offer({ providerOfferId: "needs", totalDelta: "200.00" }),
        offer({ providerOfferId: "pass", totalDelta: "299.00" }),
      ],
      // gate at 150 but ceiling high; make "pass" pass by widening the gate
      { currency: "USD", requires_approval_over: "250.00", max_add_collect: "600.00" },
      EVENT,
      NOW,
    );
    expect(ranked.map((r) => r.providerOfferId)).toEqual(["needs", "pass"]);
    // ^ with gate 250: 200 PASSes, 299 NEEDS_APPROVAL
    expect(ranked[0]!.policyVerdict).toBe("PASS");
    expect(ranked[1]!.policyVerdict).toBe("NEEDS_APPROVAL");
  });

  test("within the same verdict, cheapest wins", () => {
    const ranked = rankOffers(
      [
        offer({ providerOfferId: "c", totalDelta: "120.00" }),
        offer({ providerOfferId: "a", totalDelta: "0.00" }),
        offer({ providerOfferId: "b", totalDelta: "100.00" }),
      ],
      POLICY,
      EVENT,
      NOW,
    );
    expect(ranked.map((r) => r.providerOfferId)).toEqual(["a", "b", "c"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  test("ties on price break on earliest arrival", () => {
    const ranked = rankOffers(
      [
        offer({ providerOfferId: "later", totalDelta: "100.00", arrivesAt: "2026-09-15T16:30:00Z" }),
        offer({ providerOfferId: "earlier", totalDelta: "100.00", arrivesAt: "2026-09-15T06:05:00Z" }),
      ],
      POLICY,
      EVENT,
      NOW,
    );
    expect(ranked.map((r) => r.providerOfferId)).toEqual(["earlier", "later"]);
  });

  test("returns at most 3 and assigns contiguous ranks 1..3", () => {
    const many = ["a", "b", "c", "d", "e"].map((id, i) =>
      offer({ providerOfferId: id, totalDelta: `${i * 10}.00` }),
    );
    const ranked = rankOffers(many, POLICY, EVENT, NOW);
    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(ranked.map((r) => r.providerOfferId)).toEqual(["a", "b", "c"]);
  });

  test("is pure — does not mutate or reorder the caller's array", () => {
    const input = [
      offer({ providerOfferId: "z", totalDelta: "299.00" }),
      offer({ providerOfferId: "y", totalDelta: "0.00" }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    rankOffers(input, POLICY, EVENT, NOW);
    expect(input).toEqual(snapshot);
    expect(input[0]!.providerOfferId).toBe("z");
  });

  test("empty input yields empty output", () => {
    expect(rankOffers([], POLICY, EVENT, NOW)).toEqual([]);
  });
});

// -------------------------------------------------------------- expiry

describe("expiry", () => {
  test("isExpired uses the injected clock, never Date.now()", () => {
    const o = offer({ providerOfferId: "o", expiresAt: "2026-07-18T19:43:54Z" });
    expect(isExpired(o, new Date("2026-07-18T19:43:53Z"))).toBe(false);
    expect(isExpired(o, new Date("2026-07-18T19:43:54Z"))).toBe(false); // not yet past
    expect(isExpired(o, new Date("2026-07-18T19:43:55Z"))).toBe(true);
  });

  test("an offer with no expiry is never expired", () => {
    expect(isExpired(offer({ providerOfferId: "o", expiresAt: null }), NOW)).toBe(false);
  });

  test("expired offers are dropped from ranking entirely", () => {
    const ranked = rankOffers(
      [
        offer({ providerOfferId: "dead", totalDelta: "0.00", expiresAt: "2026-07-18T19:00:00Z" }),
        offer({ providerOfferId: "live", totalDelta: "299.00", expiresAt: "2026-07-18T20:00:00Z" }),
      ],
      POLICY,
      EVENT,
      NOW,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.providerOfferId).toBe("live");
    expect(ranked[0]!.rank).toBe(1);
  });

  test("a 7-minute hotel bookingKey expires well before a 20-minute flight offer", () => {
    const hotel = offer({ providerOfferId: "h", kind: "HOTEL", expiresAt: "2026-07-18T19:34:37Z" });
    const flight = offer({ providerOfferId: "f", kind: "FLIGHT", expiresAt: "2026-07-18T19:43:54Z" });
    const eightMinutesLater = new Date("2026-07-18T19:38:00Z");
    expect(isExpired(hotel, eightMinutesLater)).toBe(true);
    expect(isExpired(flight, eightMinutesLater)).toBe(false);
  });
});
