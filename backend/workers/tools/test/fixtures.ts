/**
 * Scenario builders on top of the seeded D1. worker/seed.sql supplies the org,
 * 26 employees, itineraries, segments and the dinner; it deliberately contains
 * no disruption/dispatch rows, so each test constructs the live-call state it
 * needs here.
 */

export type OfferSpec = {
  rank: number;
  route_summary: string;
  arrives_at?: string;
  expires_at?: string;
  policy_verdict?: "PASS" | "NEEDS_APPROVAL" | "FAIL";
  total_delta?: string;
  charge_type?: "ADD_COLLECT" | "EVEN" | "REFUND";
  currency?: string;
};

const FUTURE = "2030-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";

/** A cancelled-flight scenario: disruption_event + impact + offers. */
export async function makeImpact(
  db: D1Database,
  opts: {
    id: string;
    employeeId: string;
    itineraryId?: string;
    segmentId?: string;
    state?: string;
    carrier?: string;
    flightNo?: number;
    depDate?: string;
    origin?: string;
    dest?: string;
    offers?: OfferSpec[];
  },
): Promise<string> {
  const evId = `devt-${opts.id}`;
  await db
    .prepare(
      `INSERT INTO disruption_event (id, kind, carrier, flight_no, dep_date, origin, dest, reason, detected_at)
       VALUES (?, 'FLIGHT_CANCELLED', ?, ?, ?, ?, ?, 'Operational cancellation', '2026-09-13T12:00:00Z')`,
    )
    .bind(
      evId,
      opts.carrier ?? "DL",
      opts.flightNo ?? 7842,
      opts.depDate ?? "2026-09-14",
      opts.origin ?? "JFK",
      opts.dest ?? "ICN",
    )
    .run();

  await db
    .prepare(
      `INSERT INTO disruption_impact
         (id, event_id, employee_id, itinerary_id, state, matched_segment_id, matched_num_updates)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      opts.id,
      evId,
      opts.employeeId,
      opts.itineraryId ?? null,
      opts.state ?? "CONTACTING",
      opts.segmentId ?? null,
    )
    .run();

  for (const o of opts.offers ?? []) {
    await db
      .prepare(
        `INSERT INTO offer
           (id, impact_id, rank, provider_offer_id, expires_at, charge_type, currency,
            total_delta, route_summary, arrives_at, policy_verdict, policy_id, policy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pol-flight', 1)`,
      )
      .bind(
        `off-${opts.id}-${o.rank}`,
        opts.id,
        o.rank,
        `POID-${o.rank}`,
        o.expires_at ?? FUTURE,
        o.charge_type ?? "EVEN",
        o.currency ?? "USD",
        o.total_delta ?? "0.00",
        o.route_summary,
        o.arrives_at ?? "2026-09-15T08:50:00Z",
        o.policy_verdict ?? "PASS",
      )
      .run();
  }
  return opts.id;
}

/** A dispatch row, optionally bound to a slot. */
export async function makeDispatch(
  db: D1Database,
  opts: {
    id: string;
    kind?: "CALL_EMPLOYEE" | "CALL_VENUE" | "CALL_NOTIFY";
    impactId?: string | null;
    employeeId?: string | null;
    activityId?: string | null;
    slot?: string | null;
    status?: string;
  },
): Promise<string> {
  await db
    .prepare(
      `INSERT INTO dispatch
         (id, kind, impact_id, employee_id, activity_id, slot, directive,
          idempotency_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Discuss alternatives', ?, ?, '2026-09-13T12:05:00Z')`,
    )
    .bind(
      opts.id,
      opts.kind ?? "CALL_EMPLOYEE",
      opts.impactId ?? null,
      opts.employeeId ?? null,
      opts.activityId ?? null,
      opts.slot ?? null,
      `idem-${opts.id}`,
      opts.status ?? "IN_CALL",
    )
    .run();
  return opts.id;
}

/** Bind a slot to a dispatch with a live (or explicitly expired) lease. */
export async function bindSlot(
  db: D1Database,
  slot: string,
  dispatchId: string,
  leaseExpiresAt: string = FUTURE,
) {
  await db
    .prepare(
      `UPDATE agent_slot SET status='BOUND', dispatch_id=?, bound_at='2026-09-13T12:05:00Z',
         lease_expires_at=? WHERE slot=?`,
    )
    .bind(dispatchId, leaseExpiresAt, slot)
    .run();
}

export const EXPIRED_LEASE = PAST;
export const EXPIRED_OFFER = PAST;

/**
 * The canonical happy-path scenario used across suites: Elena Duarte
 * (emp-us-04) on the DL7842 codeshare, three precomputed alternatives.
 */
export async function scenarioElena(
  db: D1Database,
  slot = "slot-a",
  ids = { impact: "imp-elena", dispatch: "disp-elena" },
) {
  await makeImpact(db, {
    id: ids.impact,
    employeeId: "emp-us-04",
    itineraryId: "itin-us-04-f",
    segmentId: "seg-us-04",
    offers: [
      {
        rank: 1,
        route_summary: "Asiana 223, departs 1:30am, arrives 6:05am, no extra cost",
        arrives_at: "2026-09-14T21:05:00Z",
      },
      {
        rank: 2,
        route_summary: "Korean Air 82 the next day, arrives 5:50pm, 120 dollars more",
        total_delta: "120.00",
        charge_type: "ADD_COLLECT",
      },
      {
        rank: 3,
        route_summary: "Cathay Pacific via Hong Kong, arrives 9:40pm, 200 dollars more",
        total_delta: "200.00",
        charge_type: "ADD_COLLECT",
        policy_verdict: "NEEDS_APPROVAL",
      },
    ],
  });
  await makeDispatch(db, {
    id: ids.dispatch,
    impactId: ids.impact,
    employeeId: "emp-us-04",
    slot,
  });
  await bindSlot(db, slot, ids.dispatch);
  return ids;
}

/** Marcus Bell (emp-us-03) on marketing KE82 — the second concurrent caller. */
export async function scenarioMarcus(db: D1Database, slot = "slot-b") {
  await makeImpact(db, {
    id: "imp-marcus",
    employeeId: "emp-us-03",
    itineraryId: "itin-us-03-f",
    segmentId: "seg-us-03",
    carrier: "KE",
    flightNo: 82,
    offers: [
      { rank: 1, route_summary: "Asiana 223 red-eye, no extra cost" },
      { rank: 2, route_summary: "Air Premia 112 from San Francisco, 100 dollars more" },
    ],
  });
  await makeDispatch(db, {
    id: "disp-marcus",
    impactId: "imp-marcus",
    employeeId: "emp-us-03",
    slot,
  });
  await bindSlot(db, slot, "disp-marcus");
  return { impact: "imp-marcus", dispatch: "disp-marcus" };
}

/** A venue-change dispatch for the Jagalchi Hoetjip dinner (26 attendees). */
export async function scenarioVenue(db: D1Database, slot = "slot-c") {
  await makeDispatch(db, {
    id: "disp-venue",
    kind: "CALL_VENUE",
    impactId: null,
    employeeId: null,
    activityId: "act-dinner",
    slot,
  });
  await bindSlot(db, slot, "disp-venue");
  return { dispatch: "disp-venue", activity: "act-dinner" };
}
