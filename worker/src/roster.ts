/**
 * GET /api/roster?event_id=evt-busan — the dashboard's only read.
 *
 * WHY THIS IS NOT /api/dispatches
 * -------------------------------
 * /api/dispatches returns rows only for people the agent is acting on. A GREEN
 * employee has no dispatch, no impact and no offer, so it can never render a
 * 26-person roster. The spine here is `employee`; everything else is overlaid.
 *
 * THE event_id TRAP
 * -----------------
 * `disruption_impact.event_id` references disruption_event(id), NOT event(id)
 * (schema.sql:168, confirmed by brief.ts:31 joining `de.id = i.event_id`), and
 * disruption_event has no offsite foreign key at all. So the offsite is scoped
 * through employee.org_id and itinerary.event_id. Reading the parameter name at
 * face value gives a query that looks right and returns nothing.
 *
 * PERFORMANCE
 * -----------
 * One query, one row per employee. Deliberately absent:
 *   - segments[]: the card renders a sentence, not flight rows. Joining them
 *     fans 26 rows into 34 for data the card never shows. The drawer fetches
 *     them on open.
 *   - booking_snapshot: raw_json is the full get-booking payload and reshop
 *     responses run ~170KB. It sits one foreign key from itinerary and looks
 *     innocent. Never join it here.
 * The top offer is `MIN(rank)`, never `rank = 1` — schema.sql:209 is explicit
 * that rank is a priority and need not be dense.
 */
import type { Env } from "./index";
import {
  bandFor,
  deriveStatus,
  type Band,
  type DispatchStatus,
  type DisplayStatus,
  type EmployeeStatus,
  type ImpactState,
} from "./status";

export interface RosterCard {
  employeeId: string;
  name: string;
  homeBase: string | null;
  status: DisplayStatus;
  band: Band;
  advisory: string | null;
  policyVerdict: "PASS" | "NEEDS_APPROVAL" | "FAIL" | null;
  totalDelta: string | null;
  currency: string | null;
  offerCount: number;
  /** Set only when there is an open approval — the card's Approve action. */
  approvalId: string | null;
  impactId: string | null;
  /** True when the card can be approved in one click from the roster. */
  canApprove: boolean;
}

interface Row {
  employee_id: string;
  name: string;
  home_base: string | null;
  employee_status: EmployeeStatus;
  impact_id: string | null;
  impact_state: ImpactState | null;
  dispatch_status: DispatchStatus | null;
  approval_id: string | null;
  offer_count: number;
  best_route: string | null;
  best_total: string | null;
  best_currency: string | null;
  best_verdict: "PASS" | "NEEDS_APPROVAL" | "FAIL" | null;
  best_reason: string | null;
  dsr_carrier: string | null;
  dsr_flight_no: number | null;
  seg_marketing: string | null;
  seg_operating: string | null;
  has_flight: number;
  arrives_late: number;
}

export async function getRoster(env: Env, eventId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT e.id                AS employee_id,
            e.name              AS name,
            e.home_base         AS home_base,
            e.status            AS employee_status,

            imp.id              AS impact_id,
            imp.state           AS impact_state,

            d.status            AS dispatch_status,
            apr.id              AS approval_id,

            (SELECT COUNT(*) FROM offer o2 WHERE o2.impact_id = imp.id) AS offer_count,
            o.route_summary     AS best_route,
            o.total_delta       AS best_total,
            o.currency          AS best_currency,
            o.policy_verdict    AS best_verdict,
            o.policy_reason     AS best_reason,

            de.carrier          AS dsr_carrier,
            de.flight_no        AS dsr_flight_no,

            -- Codeshare identity, so the advisory can say WHY she is here.
            fs.carrier || fs.flight_no                   AS seg_marketing,
            fs.operating_carrier || fs.operating_flight_no AS seg_operating,

            CASE WHEN fi.id IS NOT NULL THEN 1 ELSE 0 END AS has_flight,
            -- Structural risk with no disruption in play: lands after the
            -- event's arrival cut-off. This is why Grace surfaces on a calm
            -- board.
            CASE WHEN fs.arr_time_utc IS NOT NULL
                       AND ev.arrival_by IS NOT NULL
                       AND fs.arr_time_utc > ev.arrival_by
                 THEN 1 ELSE 0 END                        AS arrives_late

       FROM employee e

       JOIN event ev
         ON ev.id = ?
        AND ev.org_id = e.org_id        -- the offsite scope, NOT impact.event_id

       -- The employee's flight itinerary for this offsite, if any.
       LEFT JOIN itinerary fi
         ON fi.employee_id = e.id AND fi.event_id = ev.id AND fi.component = 'FLIGHT'
       LEFT JOIN segment fs
         ON fs.itinerary_id = fi.id AND fs.type = 'FLIGHT'

       LEFT JOIN disruption_impact imp
         ON imp.employee_id = e.id
        AND imp.state <> 'RESOLVED'
       LEFT JOIN disruption_event de
         ON de.id = imp.event_id        -- NB: disruption_event, not event

       -- Most recent dispatch for this impact.
       LEFT JOIN dispatch d
         ON d.impact_id = imp.id
        AND d.created_at = (SELECT MAX(created_at) FROM dispatch d2 WHERE d2.impact_id = imp.id)

       -- The open approval, if the gate has tripped.
       LEFT JOIN approval apr
         ON apr.impact_id = imp.id AND apr.decided_at IS NULL

       -- Top-ranked offer. MIN(rank), never rank = 1: rank is a priority and
       -- is not guaranteed dense (schema.sql:209).
       LEFT JOIN offer o
         ON o.impact_id = imp.id
        AND o.rank = (SELECT MIN(rank) FROM offer o3 WHERE o3.impact_id = imp.id)

      WHERE e.org_id = ev.org_id
      ORDER BY e.name`,
  )
    .bind(eventId)
    .all<Row>();

  const cards = (results ?? []).map(toCard);

  return Response.json({
    event_id: eventId,
    synced_at: new Date().toISOString(),
    counts: countBands(cards),
    exposure: totalExposure(cards),
    cards,
  });
}

function toCard(r: Row): RosterCard {
  const status = deriveStatus({
    employeeStatus: r.employee_status,
    impactState: r.impact_state,
    dispatchStatus: r.dispatch_status,
  });

  return {
    employeeId: r.employee_id,
    name: r.name,
    homeBase: r.home_base,
    status,
    band: bandFor(status),
    advisory: composeAdvisory(r, status),
    policyVerdict: r.best_verdict,
    totalDelta: r.best_total,
    currency: r.best_currency,
    offerCount: r.offer_count ?? 0,
    approvalId: r.approval_id,
    impactId: r.impact_id,
    // One-click approve only when there is an open approval AND the top option
    // is unambiguous. A FAIL verdict means no option is both in policy and on
    // time, which is a judgement call — that one opens the drawer.
    canApprove: r.approval_id !== null && r.best_verdict === "NEEDS_APPROVAL",
  };
}

/**
 * The advisory line is the product. "Was on DL7842 — the same aircraft as
 * cancelled KE82" is the sentence that justifies the whole system; a rendering
 * of join keys is not.
 *
 * NOTE: duplicates a little of the tools package's speak.ts (carrier naming).
 * That package renders for the ear, this one for the eye. Sharing them needs a
 * workspace, which was deliberately deferred — see TODOS.md.
 */
export function composeAdvisory(r: Row, status: DisplayStatus): string | null {
  if (status === "GREEN") return null;

  // Disrupted: explain what broke, then what to do about it.
  if (r.impact_id && r.dsr_carrier && r.dsr_flight_no !== null) {
    const cancelled = `${r.dsr_carrier}${r.dsr_flight_no}`;
    const codeshare =
      r.seg_marketing && r.seg_operating && r.seg_marketing !== r.seg_operating
        ? `Was on ${r.seg_marketing} — the same aircraft as cancelled ${cancelled}.`
        : `${cancelled} was cancelled.`;

    if (r.offer_count === 0) return `${codeshare} Pricing alternatives…`;

    const money =
      r.best_total && r.best_total !== "0.00"
        ? `, add-collect ${fmtMoney(r.best_total, r.best_currency)}`
        : ", at no extra cost";
    const gate =
      r.best_verdict === "NEEDS_APPROVAL"
        ? ` ${r.best_reason ?? "Needs your sign-off."}`
        : r.best_verdict === "FAIL"
          ? ` ${r.best_reason ?? "No option is both in policy and on time."}`
          : " Within policy — the agent may book it alone.";

    return `${codeshare} Best option ${r.best_route}${money}.${gate}`;
  }

  // Structural risk, no disruption in play. These two keep the calm board from
  // reading as an empty screen.
  if (!r.has_flight) {
    return "No booking at all. The agent needs a date of birth and passport before it can ticket them.";
  }
  if (r.arrives_late) {
    return "Their flight lands after the arrival cut-off for this offsite.";
  }
  return null;
}

function fmtMoney(amount: string, currency: string | null): string {
  return currency === "USD" || currency === null ? `$${amount}` : `${amount} ${currency}`;
}

function countBands(cards: RosterCard[]) {
  return {
    travelling: cards.length,
    needs_you: cards.filter((c) => c.status === "NEEDS_YOU").length,
    at_risk: cards.filter((c) => c.status === "AT_RISK").length,
    calling: cards.filter((c) => c.status === "CALLING").length,
    booking: cards.filter((c) => c.status === "BOOKING").length,
    failed: cards.filter((c) => c.status === "FAILED").length,
    resolved: cards.filter((c) => c.status === "RESOLVED").length,
    on_track: cards.filter((c) => c.status === "GREEN").length,
  };
}

/**
 * Decimal-string arithmetic in cents. Money is never a float — schema.sql:9 is
 * explicit, and a JS float would turn 120.00 + 200.00 into 320.00000000000006.
 */
function totalExposure(cards: RosterCard[]): { amount: string; currency: string } {
  const cents = cards.reduce((sum, c) => {
    if (!c.totalDelta) return sum;
    const [whole, frac = "0"] = c.totalDelta.split(".");
    return sum + Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
  }, 0);
  return {
    amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
    currency: "USD",
  };
}
