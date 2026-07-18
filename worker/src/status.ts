/**
 * Display status for a roster card. Derived, never a single column.
 *
 * The bug this file exists to prevent: commit 7dd6ba5 added `EXECUTING` to
 * disruption_impact.state. An earlier draft of the ladder handled four states
 * and fell through to GREEN for the rest, so EXECUTING, CONTACTING and — worst
 * — FAILED all rendered as "on track". A failed rebooking displayed as fine on
 * a crisis dashboard.
 *
 * So the switch below is exhaustive over both enums and ends in a `never`
 * check. Add an eighth impact state and this stops compiling. That is the whole
 * point: the type system, not a reviewer, catches the next one.
 *
 *   dispatch.status IN (DIALING, IN_CALL)   -> CALLING
 *   impact.state = AWAITING_APPROVAL        -> NEEDS_YOU     (the only actionable one)
 *   impact.state = FAILED                   -> FAILED
 *   impact.state = EXECUTING                -> BOOKING
 *   impact.state = CONTACTING               -> CALLING
 *   impact.state IN (DETECTED, TRIAGING)    -> AT_RISK
 *   impact.state = RESOLVED                 -> RESOLVED
 *   employee.status = AT_RISK               -> AT_RISK       (structural, no impact row)
 *   employee.status = DELAYED               -> AT_RISK
 *   employee.status = RESOLVED              -> RESOLVED
 *   otherwise                               -> GREEN
 */

/** disruption_impact.state — schema.sql:174 */
export type ImpactState =
  | "DETECTED"
  | "TRIAGING"
  | "AWAITING_APPROVAL"
  | "CONTACTING"
  | "EXECUTING"
  | "RESOLVED"
  | "FAILED";

/** dispatch.status — schema.sql:271 */
export type DispatchStatus =
  | "QUEUED"
  | "DIALING"
  | "IN_CALL"
  | "RESOLVING"
  | "RESOLVED"
  | "FAILED"
  | "NO_ANSWER";

/** employee.status — schema.sql:51 */
export type EmployeeStatus = "OK" | "AT_RISK" | "DELAYED" | "RESOLVED";

/** What the card actually renders. This is the only status the frontend sees. */
export type DisplayStatus =
  | "GREEN"
  | "AT_RISK"
  | "NEEDS_YOU"
  | "CALLING"
  | "BOOKING"
  | "FAILED"
  | "RESOLVED";

/** Roster bands, in the order they appear on screen. */
export type Band = "NEEDS_YOU" | "FAILED" | "WORKING" | "RESOLVED" | "ON_TRACK";

export interface StatusInput {
  employeeStatus: EmployeeStatus;
  impactState: ImpactState | null;
  dispatchStatus: DispatchStatus | null;
}

export function deriveStatus(input: StatusInput): DisplayStatus {
  const { employeeStatus, impactState, dispatchStatus } = input;

  // A live call outranks everything. The agent is on the phone right now, and
  // that is the most useful thing the coordinator can know about this person.
  if (dispatchStatus === "DIALING" || dispatchStatus === "IN_CALL") return "CALLING";

  // A call that ended badly must not leave the card looking busy. Without this,
  // a NO_ANSWER against an impact still in CONTACTING renders as CALLING
  // forever.
  if (dispatchStatus === "FAILED" || dispatchStatus === "NO_ANSWER") {
    if (impactState !== "RESOLVED") return "FAILED";
  }

  if (impactState !== null) {
    switch (impactState) {
      case "AWAITING_APPROVAL":
        return "NEEDS_YOU";
      case "FAILED":
        return "FAILED";
      case "EXECUTING":
        return "BOOKING";
      case "CONTACTING":
        return "CALLING";
      case "DETECTED":
      case "TRIAGING":
        return "AT_RISK";
      case "RESOLVED":
        return "RESOLVED";
      default:
        return assertNever(impactState, "impact state");
    }
  }

  // No impact row. Fall back to the employee's own standing state — this is how
  // Grace Lombardi (lands past arrival_by) and Nora Feldman (no itinerary at
  // all) surface with no disruption in play. It is why the screen is never
  // empty.
  switch (employeeStatus) {
    case "AT_RISK":
    case "DELAYED":
      return "AT_RISK";
    case "RESOLVED":
      return "RESOLVED";
    case "OK":
      return "GREEN";
    default:
      return assertNever(employeeStatus, "employee status");
  }
}

/** Which band a card sorts into. Drives the six sections of the roster. */
export function bandFor(status: DisplayStatus): Band {
  switch (status) {
    case "NEEDS_YOU":
      return "NEEDS_YOU";
    case "FAILED":
      return "FAILED";
    case "CALLING":
    case "BOOKING":
    case "AT_RISK":
      return "WORKING";
    case "RESOLVED":
      return "RESOLVED";
    case "GREEN":
      return "ON_TRACK";
    default:
      return assertNever(status, "display status");
  }
}

/**
 * Compile-time exhaustiveness. If someone adds an eighth impact state without
 * handling it, `value` stops being `never` and this file fails to build.
 * The runtime throw is a belt-and-braces for data that bypassed the type
 * system, e.g. a row written by an older deploy.
 */
function assertNever(value: never, what: string): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(value)}`);
}
