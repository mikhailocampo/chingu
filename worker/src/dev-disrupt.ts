/**
 * POST /api/dev/disrupt  — fire a scripted disruption. Dev-gated.
 * POST /api/dev/reset    — put the board back to seed state.
 *
 * This is the seam that makes the demo lifecycle reachable. seed.sql ships zero
 * disruption_event, disruption_impact, offer, dispatch and approval rows, so
 * without this the roster is 24 green cards and two structurally at-risk people
 * forever.
 *
 * THE CODESHARE IS THE POINT
 * --------------------------
 * Cancelling KE82 must catch four travellers, and the fourth is only reachable
 * through the operating_carrier branch: Elena Duarte is ticketed on marketing
 * DL7842, flown as KE82. Match on marketing carrier alone and she is silently
 * stranded while the dashboard reports all-clear.
 *
 * There is a second, independent way to lose her. SABRE_LEARNINGS.md:26:
 * search-flights returns `marketingAirlineCode`, get-booking returns the same
 * concept as bare `airlineCode`. Normalise a booking payload with search field
 * names and you get carrier: null and an index that matches nothing. The seed
 * carries a second codeshare (DL7861 flown as KE24) so neither bug can be
 * papered over by special-casing flight 82.
 *
 * OFFERS: CACHED ECONOMICS, NEVER CACHED IDS
 * ------------------------------------------
 * offer.expires_at is real and enforced (confirm-choice.ts:115) and flight
 * offers live ~20 minutes. A cached provider_offer_id is guaranteed dead by
 * demo time, and it fails politely — the agent apologises and nothing books.
 *
 * So we seed the economics, which SABRE_LEARNINGS.md:13 verified are accurate
 * (reshop totalFee == changeItems.maxCharge at search time), and leave
 * provider_offer_id NULL. The single on-stage reissue fetches a live one.
 * Nothing here expires, so re-running the disruption is free.
 */
import type { Env } from "./index";

/** Deterministic so pressing the button twice cannot inflate the board. */
const EVENT_ID = "dsr-ke82-20260914";

const SCENARIO = {
  kind: "FLIGHT_CANCELLED" as const,
  carrier: "KE",
  flightNo: 82,
  depDate: "2026-09-14",
  origin: "JFK",
  dest: "ICN",
  reason: "Aircraft technical — A380 withdrawn from service",
};

/**
 * The three alternatives, priced from real CERT data (HACKATHON_CONTEXT:59-61).
 * Tuned against policy `pol-flight` (requires_approval_over = 150.00) so one
 * option clears on its own and two need a human. That split is the product.
 *
 * `rank` is a priority, not the number spoken aloud — schema.sql:209 is explicit
 * that callers renumber by position, so it need not be dense.
 */
const OFFERS = [
  {
    rank: 1,
    routeSummary: "Asiana 223, departing 1:30 in the morning, arriving 6:05 the next day",
    arrivesAt: "2026-09-14T21:05:00Z",
    fareDelta: "0.00",
    taxDelta: "0.00",
    feeDelta: "120.00",
    totalDelta: "120.00",
    chargeType: "ADD_COLLECT" as const,
    verdict: "PASS" as const,
    reason: "Within the $150 approval threshold and arrives before the event cut-off.",
  },
  {
    rank: 2,
    routeSummary: "Cathay Pacific 841 and 416 by way of Hong Kong, arriving 8:40",
    arrivesAt: "2026-09-15T00:40:00Z",
    fareDelta: "0.00",
    taxDelta: "0.00",
    feeDelta: "200.00",
    totalDelta: "200.00",
    chargeType: "ADD_COLLECT" as const,
    verdict: "NEEDS_APPROVAL" as const,
    reason: "$200 add-collect exceeds the $150 threshold set by pol-flight v1.",
  },
  {
    rank: 3,
    routeSummary: "United 805, basic economy, arriving 7:20 in the evening",
    arrivesAt: "2026-09-15T19:20:00Z",
    fareDelta: "0.00",
    taxDelta: "0.00",
    feeDelta: "299.00",
    totalDelta: "299.00",
    chargeType: "ADD_COLLECT" as const,
    verdict: "NEEDS_APPROVAL" as const,
    reason: "$299 non-refundable, and lands after the arrival cut-off.",
  },
];

interface AffectedRow {
  employee_id: string;
  employee_name: string;
  itinerary_id: string;
  segment_id: string;
  marketing: string;
  operating: string;
  num_updates: number | null;
}

/**
 * Who is on this flight, counting codeshares.
 *
 * The OR is load-bearing. Both halves are indexed (idx_seg_marketing and
 * idx_seg_operating) precisely so this stays a seek.
 */
export async function findAffected(env: Env): Promise<AffectedRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.id                       AS employee_id,
            e.name                     AS employee_name,
            i.id                       AS itinerary_id,
            s.id                       AS segment_id,
            s.carrier || s.flight_no   AS marketing,
            s.operating_carrier || s.operating_flight_no AS operating,
            i.last_num_updates         AS num_updates
       FROM segment s
       JOIN itinerary i ON i.id = s.itinerary_id
       JOIN employee  e ON e.id = i.employee_id
      WHERE s.type = 'FLIGHT'
        AND s.dep_date = ?
        AND (   (s.carrier           = ? AND s.flight_no           = ?)
             OR (s.operating_carrier = ? AND s.operating_flight_no = ?) )
      ORDER BY e.id`,
  )
    .bind(SCENARIO.depDate, SCENARIO.carrier, SCENARIO.flightNo, SCENARIO.carrier, SCENARIO.flightNo)
    .all<AffectedRow>();

  return results ?? [];
}

export async function disrupt(env: Env, now: Date): Promise<Response> {
  const detectedAt = now.toISOString();
  const affected = await findAffected(env);

  if (affected.length === 0) {
    return Response.json(
      { error: "no travellers matched — is the database seeded?" },
      { status: 409 },
    );
  }

  const statements = [
    env.DB.prepare(
      `INSERT INTO disruption_event
         (id, kind, carrier, flight_no, dep_date, origin, dest, reason, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET detected_at = excluded.detected_at`,
    ).bind(
      EVENT_ID,
      SCENARIO.kind,
      SCENARIO.carrier,
      SCENARIO.flightNo,
      SCENARIO.depDate,
      SCENARIO.origin,
      SCENARIO.dest,
      SCENARIO.reason,
      detectedAt,
    ),
  ];

  for (const row of affected) {
    const impactId = impactIdFor(row.employee_id);

    // OR IGNORE, not OR REPLACE: re-firing the disruption mid-demo must not
    // reset an impact that has already moved to AWAITING_APPROVAL or RESOLVED.
    // Rewinding the board is what /api/dev/reset is for.
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO disruption_impact
           (id, event_id, employee_id, itinerary_id, state, state_changed_at,
            matched_segment_id, matched_num_updates)
         VALUES (?, ?, ?, ?, 'TRIAGING', ?, ?, ?)`,
      ).bind(
        impactId,
        EVENT_ID,
        row.employee_id,
        row.itinerary_id,
        detectedAt,
        row.segment_id,
        // Staleness guard. DATA_MODEL.md:225 — compare before acting; if the
        // itinerary moved underneath us, re-triage rather than apply a decision
        // made against a stale segment.
        row.num_updates,
      ),
    );

    // Offers are derived and carry no live IDs, so rewriting them is safe and
    // keeps a re-run honest if the pricing table above changes.
    for (const o of OFFERS) {
      statements.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO offer
             (id, impact_id, rank, provider_offer_id, expires_at, charge_type,
              currency, fare_delta, tax_delta, fee_delta, total_delta,
              route_summary, arrives_at, policy_verdict, policy_id,
              policy_version, policy_reason)
           VALUES (?, ?, ?, NULL, NULL, ?, 'USD', ?, ?, ?, ?, ?, ?, ?,
                   'pol-flight', 1, ?)`,
        ).bind(
          `ofr-${impactId}-${o.rank}`,
          impactId,
          o.rank,
          o.chargeType,
          o.fareDelta,
          o.taxDelta,
          o.feeDelta,
          o.totalDelta,
          o.routeSummary,
          o.arrivesAt,
          o.verdict,
          o.reason,
        ),
      );
    }
  }

  await env.DB.batch(statements);

  return Response.json({
    ok: true,
    event_id: EVENT_ID,
    flight: `${SCENARIO.carrier}${SCENARIO.flightNo}`,
    dep_date: SCENARIO.depDate,
    affected: affected.map((r) => ({
      employee_id: r.employee_id,
      name: r.employee_name,
      marketing: r.marketing,
      operating: r.operating,
      // Surfaced so the demo can point at it: she is only here because of the
      // operating-carrier branch.
      via_codeshare: r.marketing !== r.operating,
    })),
    offers_per_impact: OFFERS.length,
    total_offers: affected.length * OFFERS.length,
  });
}

/** Wipe everything this seam created. Returns the board to seed state. */
export async function reset(env: Env): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM approval WHERE impact_id IN
         (SELECT id FROM disruption_impact WHERE event_id = ?)`,
    ).bind(EVENT_ID),
    env.DB.prepare(
      `DELETE FROM action WHERE subject_type = 'impact' AND subject_id IN
         (SELECT id FROM disruption_impact WHERE event_id = ?)`,
    ).bind(EVENT_ID),
    env.DB.prepare(
      `DELETE FROM offer WHERE impact_id IN
         (SELECT id FROM disruption_impact WHERE event_id = ?)`,
    ).bind(EVENT_ID),
    env.DB.prepare(
      `DELETE FROM dispatch WHERE impact_id IN
         (SELECT id FROM disruption_impact WHERE event_id = ?)`,
    ).bind(EVENT_ID),
    env.DB.prepare(`DELETE FROM disruption_impact WHERE event_id = ?`).bind(EVENT_ID),
    env.DB.prepare(`DELETE FROM disruption_event WHERE id = ?`).bind(EVENT_ID),

    // Free any slot bound to a dispatch we just deleted.
    //
    // Without this, reset leaves a DANGLING BINDING: agent_slot still points at
    // a dispatch row that no longer exists, so the next get_brief resolves to a
    // ghost. agent_slot is authoritative for resolution (schema.sql:244), so a
    // stale row there is not cosmetic — it is the agent being told to talk to
    // someone who isn't there.
    //
    // status and lease move together: the CHECK at schema.sql:253 only permits
    // a NULL lease when the slot is FREE.
    env.DB.prepare(
      `UPDATE agent_slot
          SET status = 'FREE', dispatch_id = NULL, bound_at = NULL, lease_expires_at = NULL
        WHERE dispatch_id IS NOT NULL
          AND dispatch_id NOT IN (SELECT id FROM dispatch)`,
    ),
  ]);

  return Response.json({ ok: true, reset: EVENT_ID });
}

export function impactIdFor(employeeId: string): string {
  return `imp-${EVENT_ID}-${employeeId}`;
}

export const DISRUPT_EVENT_ID = EVENT_ID;
export const DISRUPT_SCENARIO = SCENARIO;
export const DISRUPT_OFFERS = OFFERS;
